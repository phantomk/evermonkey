import * as buffer from "buffer";
import * as vscode from "vscode";
import Converter from "./converterplus";
import * as _ from "lodash";
import * as open from "opener";
import * as util from "util";
import * as path from "path";
import {
  hash,
  guessMime
} from "./myutil";
import fs from "./file";
import * as evernote from "evernote";
import {
  EvernoteClient
} from "./everapi";

const config = vscode.workspace.getConfiguration("evermonkey");

const ATTACHMENT_FOLDER_PATH = path.join(__dirname, config.attachmentsFolder || "../../attachments");
const ATTACHMENT_SOURCE_LOCAL = 0;
const ATTACHMENT_SOURCE_SERVER = 1;
const TIP_BACK = "back...";
const METADATA_PATTERN = /^---[ \t]*\n((?:[ \t]*[^ \t:]+[ \t]*:[^\n]*\n)+)---[ \t]*\n/;

const METADATA_HEADER = `\
---
title: %s
tags: %s
notebook: %s
---
`;

// notesMap -- [notebookguid:[notes]].
let notebooks, notesMap, selectedNotebook;
const localNote = {};
let showTips;
let client;
const serverResourcesCache = {};
const tagCache = {};
const converter = new Converter({});

// doc -> [{filepath: attachment}]
const attachmentsCache = {};

//  exact text Metadata by convention
function exactMetadata(text) {
  let metadata = {};
  let content = text;
  if (_.startsWith(text, "---")) {
    let match = METADATA_PATTERN.exec(text);
    if (match) {
      content = text.substring(match[0].trim().length);
      let metadataStr = match[1].trim();
      let metaArray = metadataStr.split("\n");
      metaArray.forEach(value => {
        let entry = value.split(":");
        metadata[entry[0]] = entry[1].trim();
      });
      if (metadata["tags"]) {
        let tagStr = metadata["tags"];
        metadata["tags"] = tagStr.split(",").map(value => value.trim());
      }
    }
  }
  return {
    "metadata": metadata,
    "content": content
  };
}

function genMetaHeader(title, tags, notebook) {
  return util.format(METADATA_HEADER, title, tags.join(","), notebook);
}

// nav to one Note
async function navToNote() {
  try {
    const notebooksName = await listNotebooks();
    const selectedNotebook = await vscode.window.showQuickPick(notebooksName);
    if (!selectedNotebook) {
      throw ""; // user dismisss
    }
    const noteLists = await listNotes(selectedNotebook);
    if (!noteLists) {
      await vscode.window.showInformationMessage("Can not open an empty notebook.");
      return navToNote();
    } else {
      let noteTitles = noteLists.map(note => note.title);
      const selectedNote = await vscode.window.showQuickPick(noteTitles.concat(TIP_BACK));
      if (!selectedNote) {
        throw "";
      }
      return openNote(selectedNote);
    }
  } catch (err) {
    wrapError(err);
  }

}


// Synchronize evernote account. For metadata.
async function syncAccount() {
  try {
    client = new EvernoteClient(config.token, config.noteStoreUrl);
    const tags = await client.listTags();
    tags.forEach(tag => tagCache[tag.guid] = tag.name);
    await vscode.window.setStatusBarMessage("Synchronizing your account...", 1000);
    notebooks = await client.listNotebooks();
    let promises = notebooks.map(notebook => client.listAllNoteMetadatas(notebook.guid));
    const allMetas = await Promise.all(promises);
    const notes = _.flattenDeep(allMetas.map((meta: evernote.Types.Note) => meta.notes));
    notesMap = _.groupBy(notes, "notebookGuid");
    vscode.window.setStatusBarMessage("Synchronizing succeeded!", 1000);
  } catch (err) {
    wrapError(err);
  }
}

// add attachtment to note.
async function attachToNote() {
  try {
    if (!notebooks || !notesMap) {
      await syncAccount();
    }
    const editor = await vscode.window.activeTextEditor;
    let doc = editor.document;
    let filepath = await vscode.window.showInputBox({
      placeHolder: "Full path of your attachtment:"
    });
    if (!filepath) {
      throw "";
    }
    if (config.uploadFolder) {
      const folderExsit = await fs.exsit(config.uploadFolder);
      if (folderExsit) {
        filepath = path.join(config.uploadFolder, filepath);
      }
    } else {
      vscode.window.showWarningMessage("Attachments upload folder not setted, you may have to use absolute file path.")
    }
    const fileName = path.basename(filepath);
    const mime: string = guessMime(fileName);
    const data = await fs.readFileAsync(filepath);
    const md5 = hash(data);
    const attachment = {
      "mime": mime,
      "data": {
        "body": data,
        "size": data.length,
        "bodyHash": md5
      },
      "attributes": {
        "fileName": fileName,
        "attachment": true
      }
    };
    const cache = {};
    cache[filepath] = attachment;
    attachmentsCache[doc.fileName].push(cache);
    vscode.window.showInformationMessage(util.format("%s has been attched to current note.", fileName));
  } catch (err) {
    wrapError(err);
  }
}

// remove a local attachment.
async function removeAttachment() {
    const editor = await vscode.window.activeTextEditor;
    let doc = editor.document;
    // Can only remove an attachment from a cache file
    if (attachmentsCache[doc.fileName]) {
      let localAttachments = attachmentsCache[doc.fileName].map(cache => _.values(cache)[0]);
      const selectedAttachment = await vscode.window.showQuickPick(localAttachments.map(attachment => attachment.attributes.fileName));
      if (!selectedAttachment) {
        throw "";
      }
      let attachmentToRemove = localAttachments.find(attachment => attachment.attributes.fileName === selectedAttachment);
      _.remove(attachmentsCache[doc.fileName], cache => _.values(cache)[0].attributes.fileName === selectedAttachment);
      vscode.window.showInformationMessage(util.format("%s has been removed from current note.", selectedAttachment));
    }
}

// list current file attachment.
async function listResources() {
  try {
    const editor = await vscode.window.activeTextEditor;
    let doc = editor.document;
    let localResources;
    let serverResources = serverResourcesCache[doc.fileName];
    // open a note from server ,may have resouces
    if (localNote[doc.fileName]) {
      const result = await client.getNoteResources(localNote[doc.fileName].guid);
      serverResources = result.resources;
      serverResourcesCache[doc.fileName] = serverResources;
    }
    // show local cache only.
    localResources = attachmentsCache[doc.fileName].map(cache => _.values(cache)[0]);
    let serverResourcesName = [];
    let localResourcesName = [];

    if (serverResources) {
      serverResourcesName = serverResources.map(attachment => "(server) " + attachment.attributes.fileName);
    }

    if (localResources) {
      localResourcesName = localResources.map(attachment => "(local) " + attachment.attributes.fileName);
    }

    if (serverResourcesName || localResourcesName) {
      const selected = await vscode.window.showQuickPick(serverResourcesName.concat(localResourcesName));
      // do not handle now.
      if (!selected) {
        throw "";
      }
      let selectedAttachment;
      let selectedFileName;
      let source;
      let uri;
      if (selected.startsWith("(server) ")) {
        selectedFileName = selected.substr(9);
        selectedAttachment = serverResources.find(resource => resource.attributes.fileName === selectedFileName);
        source = ATTACHMENT_SOURCE_SERVER;
      } else {
        selectedFileName = selected.substr(8);
        selectedAttachment = localResources.find(resource => resource.attributes.fileName === selectedFileName);
        source = ATTACHMENT_SOURCE_LOCAL;
        let selectedCache = attachmentsCache[doc.fileName].find(cache => _.values(cache)[0].attributes.fileName === selectedFileName);
        uri = _.keys(selectedCache)[0];
      }
      openAttachment(selectedAttachment, source, uri);
    } else {
      vscode.window.showInformationMessage("No resouce to show.");
    }
  } catch (err) {
    wrapError(err);
  }

}

// open an attachment, use default app.
async function openAttachment(attachment, source, uri) {
  switch (source) {
    case ATTACHMENT_SOURCE_LOCAL:
      try {
        open(uri);
      } catch (err) {
        wrapError(err);
      }
      break;
    case ATTACHMENT_SOURCE_SERVER:
      const resource = await client.getResource(attachment.guid);
      const fileName = resource.attributes.fileName;
      const data = resource.data.body;
      try {
        const isExist = await fs.exsit(ATTACHMENT_FOLDER_PATH);
        if (!isExist) {
          await fs.mkdirAsync(ATTACHMENT_FOLDER_PATH);
        }
        const tmpDir = await fs.mkdtempAsync(path.join(ATTACHMENT_FOLDER_PATH, "./evermonkey-"));
        const filepath = path.join(tmpDir, fileName);
        await fs.writeFileAsync(filepath, data);
        open(filepath);
      } catch (error) {
        wrapError(error);
      }
      break;
  }
}



// Publish note to Evernote Server. with resources.
async function publishNote() {
  try {
    if (!notebooks || !notesMap) {
      await syncAccount();
    }
    const editor = await vscode.window.activeTextEditor;
    let doc = editor.document;
    let result = exactMetadata(doc.getText());
    let content = await converter.toEnml(result.content);
    let meta = result.metadata;
    let title = meta["title"];
    let resources = attachmentsCache[doc.fileName].map(cache => _.values(cache)[0]);
    if (localNote[doc.fileName]) {
      // update the note.
      vscode.window.setStatusBarMessage("Updaing the note.", 2000);
      let updatedNote;
      let noteGuid = localNote[doc.fileName].guid;
      const noteResources = await client.getNoteResources(noteGuid);
      if (noteResources.resources || resources) {
        if (noteResources.resources) {
          resources = resources.concat(noteResources.resources);
        }
        content = appendResourceContent(resources, content);
        updatedNote = await updateNoteResources(meta, content, noteGuid, resources);
        updatedNote.resources = resources;
        serverResourcesCache[doc.fileName] = null;
      } else {
        updatedNote = await updateNoteContent(meta, content, noteGuid);
      }
      localNote[doc.fileName] = updatedNote;
      let notebookName = notebooks.find(notebook => notebook.guid === updatedNote.notebookGuid).name;
      // attachments cache should be removed.
      attachmentsCache[doc.fileName] = [];
      return vscode.window.showInformationMessage(`${notebookName}>>${title} updated successfully.`);
    } else {
      vscode.window.setStatusBarMessage("Creating the note.", 2000);
      content = appendResourceContent(resources, content);
      const createdNote = await createNote(meta, content, resources);
      createdNote.resources = resources;
      if (!notesMap[createdNote.notebookGuid]) {
        notesMap[createdNote.notebookGuid] = [createdNote];
      } else {
        notesMap[createdNote.notebookGuid].push(createdNote);
      }
      localNote[doc.fileName] = createdNote;
      let notebookName = notebooks.find(notebook => notebook.guid === createdNote.notebookGuid).name;
      attachmentsCache[doc.fileName] = [];
      return vscode.window.showInformationMessage(`${notebookName}>>${title} created successfully.`);
    }
  } catch (err) {
    wrapError(err);
  }
}

// add resource data to note content. -- Note: server body hash is
function appendResourceContent(resources, content) {
  if (resources) {
    content = content.slice(0, -10);
    resources.forEach(attachment => {
      content = content + util.format('<en-media type="%s" hash="%s"/>', attachment.mime, Buffer.from(attachment.data.bodyHash).toString("hex"));
    });
    content = content + "</en-note>";
  }
  return content;
}

// Update an exsiting note.
async function updateNoteResources(meta, content, noteGuid, resources) {
  try {
    let tagNames = meta["tags"];
    let title = meta["title"];
    let notebook = meta["notebook"];
    const notebookGuid = await getNotebookGuid(notebook);
    return client.updateNoteResources(noteGuid, title, content, tagNames, notebookGuid, resources || void 0);

  } catch (err) {
    wrapError(err);
  }
}

async function updateNoteContent(meta, content, noteGuid) {
  try {
    let tagNames = meta["tags"];
    let title = meta["title"];
    let notebook = meta["notebook"];
    const notebookGuid = await getNotebookGuid(notebook);
    return client.updateNoteContent(noteGuid, title, content, tagNames, notebookGuid);

  } catch (err) {
    wrapError(err);
  }
}

// Choose notebook. Used for publish.
async function getNotebookGuid(notebook) {
  try {
    let notebookGuid;
    if (notebook) {
      let notebookLocal = notebooks.find(nb => nb.name === notebook);
      if (notebookLocal) {
        notebookGuid = notebookLocal.guid;
      } else {
        const createdNotebook = await client.createNotebook(notebook);
        notebooks.push(createdNotebook);
        notebookGuid = createdNotebook.guid;
      }
    } else {
      const defaultNotebook = await client.getDefaultNotebook();
      notebookGuid = defaultNotebook.guid;
    }
    return notebookGuid;
  } catch (err) {
    wrapError(err);
  }
}

// Create an new note.
async function createNote(meta, content, resources) {
  try {
    let tagNames = meta["tags"];
    let title = meta["title"];
    let notebook = meta["notebook"];
    const notebookGuid = await getNotebookGuid(notebook);
    return client.createNote(title, notebookGuid, content, tagNames, resources);
  } catch (err) {
    wrapError(err);
  }
}

// List all notebooks name.
async function listNotebooks() {
  try {
    if (!notebooks || !notesMap) {
      await syncAccount();
    }
    return notebooks.map(notebook => notebook.name);
  } catch (err) {
    wrapError(err);
  }

}

// List notes in the notebook. (200 limits.)
function listNotes(notebook) {
  selectedNotebook = notebooks.find(nb => nb.name === notebook);
  let noteLists = notesMap[selectedNotebook.guid];
  return noteLists;
}

// Create an empty note with metadata and markdown support in vscode.
async function newNote() {
  try {
    if (!notebooks) {
      await syncAccount();
    }
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown"
    });
    // init attachment cache
    attachmentsCache[doc.fileName] = [];
    const editor = await vscode.window.showTextDocument(doc);
    let startPos = new vscode.Position(1, 0);
    editor.edit(edit => {
      let metaHeader = util.format(METADATA_HEADER, "", "", "");
      edit.insert(startPos, metaHeader);
    });
  } catch (err) {
    wrapError(err);
  }

}

// Search note.
async function searchNote() {
  try {
    if (!notesMap || !notebooks) {
      await syncAccount();
    }
    const query = await vscode.window.showInputBox({
      placeHolder: "Use Evernote Search Grammar to search notes."
    });
    const searchResult = await client.searchNote(query);
    const noteWithbook = searchResult.notes.map(note => {
      let title = note["title"];
      selectedNotebook = notebooks.find(notebook => notebook.guid === note.notebookGuid);
      return selectedNotebook.name + ">>" + title;
    });
    const selectedNote = await vscode.window.showQuickPick(noteWithbook);
    if (!selectedNote) {
      throw ""; // user dismiss
    }
    await openSearchResult(selectedNote, searchResult.notes);
  } catch (err) {
    wrapError(err);
  }
}

async function openRecentNotes() {
  try {
    if (!notebooks || !notesMap) {
      await syncAccount();
    }
    const recentResults = await client.listRecentNotes();
    const recentNotes = recentResults.notes;
    const selectedNoteTitle = await vscode.window.showQuickPick(recentNotes.map(note => note.title));
    if (!selectedNoteTitle) {
      throw "";
    }
    let selectedNote = recentNotes.find(note => note.title === selectedNoteTitle);
    selectedNotebook = notebooks.find(notebook => notebook.guid === selectedNote.notebookGuid);
    return openNote(selectedNoteTitle);
  } catch (err) {
    wrapError(err);
  }
}

// Open search result note. (notebook >> note)
async function openSearchResult(noteWithbook, notes) {
  try {
    let index = noteWithbook.indexOf(">>");
    let searchNoteResult = noteWithbook.substring(index + 2);
    let chooseNote = notes.find(note => note.title === searchNoteResult);
    const content = await client.getNoteContent(chooseNote.guid);
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown"
    });
    await cacheAndOpenNote(chooseNote, doc, content);
  } catch (err) {
    wrapError(err);
  }

}

// Open note by title in vscode
async function openNote(noteTitle) {
  try {
    if (noteTitle === TIP_BACK) {
      return navToNote();
    }
    let selectedNote = notesMap[selectedNotebook.guid].find(note => note.title === noteTitle);
    const content = await client.getNoteContent(selectedNote.guid);
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown"
    });
    // attachtment cache init.
    attachmentsCache[doc.fileName] = [];
    await cacheAndOpenNote(selectedNote, doc, content);
  } catch (err) {
    wrapError(err);
  }
}

async function openNoteInBrowser() {
  const editor = await vscode.window.activeTextEditor;
  let doc = editor.document;
  if (localNote[doc.fileName]) {
    let noteGuid = localNote[doc.fileName].guid;
    if (noteGuid) {
      const idx = config.noteStoreUrl.indexOf("/shard");
      const domain = config.noteStoreUrl.substring(0, idx);
      const url = util.format(domain + "/Home.action#n=%s&ses=4&sh=2&sds=5&", noteGuid);
      open(url);
    }
  } else {
      vscode.window.showWarningMessage("Can not open the note, maybe not on the server");
  }
}


// Open note in vscode and cache to memory.
async function cacheAndOpenNote(note, doc, content) {
  try {
    const editor = await vscode.window.showTextDocument(doc);
    localNote[doc.fileName] = note;
    let startPos = new vscode.Position(1, 0);
    editor.edit(edit => {
      let mdContent = converter.toMd(content);
      let tagGuids = note.tagGuids;
      let tags;
      if (tagGuids) {
        tags = tagGuids.map(guid => tagCache[guid]);
      } else {
        tags = [];
      }
      let metaHeader = genMetaHeader(note.title, tags,
        notebooks.find(notebook => notebook.guid === note.notebookGuid).name);
      edit.insert(startPos, metaHeader + mdContent);
    });
  } catch (err) {
    wrapError(err);
  }
}

// open evernote dev page.
function openDevPage() {
  vscode.window.showQuickPick(["China", "Other"]).then(choice => {
    if (!choice) {
      return;
    }
    if (choice === "China") {
      open("https://app.yinxiang.com/api/DeveloperToken.action");
    } else {
      open("https://www.evernote.com/api/DeveloperToken.action");
    }
  });
}

function wrapError(error) {
  if (!error) {
    return;
  }
  console.log(error);

  let errMsg;
  if (error.statusCode && error.statusMessage) {
    errMsg = `Http Error: ${error.statusCode}- ${error.statusMessage}, Check your ever config please.`;
  } else if (error.errorCode && error.parameter) {
    errMsg = `Evernote Error: ${error.errorCode} - ${error.parameter}`;
  } else {
    errMsg = "Unexpected Error: " + error;
  }

  vscode.window.showErrorMessage(errMsg);
}

function activate(context) {

  if (!config.token || !config.noteStoreUrl) {
    vscode.window.showWarningMessage("Please use ever token command to get the token and storeUrl, copy&paste to the settings, and then restart the vscode.");
    vscode.commands.executeCommand("workbench.action.openGlobalSettings");
  }
  // quick match for monkey.
  let action = vscode.languages.registerCompletionItemProvider(["plaintext", {
    "scheme": "untitled",
    "language": "markdown"
  }], {
      provideCompletionItems(doc, position) {
        // simple but enough validation for title, tags, notebook
        // title dont show tips.
        if (position.line === 1) {
          return [];
        } else if (position.line === 2) {
          // tags
          if (tagCache) {
            return _.values(tagCache).map(tag => new vscode.CompletionItem(tag));
          }
        } else if (position.line === 3) {
          if (notebooks) {
            return notebooks.map(notebook => new vscode.CompletionItem(notebook.name));
          }
        }

      }
    });
  vscode.workspace.onDidCloseTextDocument(removeLocal);
  vscode.workspace.onDidSaveTextDocument(alertToUpdate);
  let listAllNotebooksCmd = vscode.commands.registerCommand("extension.navToNote", navToNote);
  let publishNoteCmd = vscode.commands.registerCommand("extension.publishNote", publishNote);
  let openDevPageCmd = vscode.commands.registerCommand("extension.openDevPage", openDevPage);
  let syncCmd = vscode.commands.registerCommand("extension.sync", syncAccount);
  let newNoteCmd = vscode.commands.registerCommand("extension.newNote", newNote);
  let searchNoteCmd = vscode.commands.registerCommand("extension.searchNote", searchNote);
  let openRecentNotesCmd = vscode.commands.registerCommand("extension.openRecentNotes", openRecentNotes);
  let attachToNoteCmd = vscode.commands.registerCommand("extension.attachToNote", attachToNote);
  let listResourcesCmd = vscode.commands.registerCommand("extension.listResources", listResources);
  let openNoteInBrowserCmd = vscode.commands.registerCommand("extension.openNoteInBrowser", openNoteInBrowser);
  let removeAttachmentCmd = vscode.commands.registerCommand("extension.removeAttachment", removeAttachment);

  context.subscriptions.push(listAllNotebooksCmd);
  context.subscriptions.push(publishNoteCmd);
  context.subscriptions.push(openDevPageCmd);
  context.subscriptions.push(syncCmd);
  context.subscriptions.push(newNoteCmd);
  context.subscriptions.push(action);
  context.subscriptions.push(searchNoteCmd);
  context.subscriptions.push(openRecentNotesCmd);
  context.subscriptions.push(attachToNoteCmd);
  context.subscriptions.push(listResourcesCmd);
  context.subscriptions.push(openNoteInBrowserCmd);
  context.subscriptions.push(removeAttachmentCmd);

}
exports.activate = activate;

// remove local cache when closed the editor.
function removeLocal(event) {
  localNote[event.fileName] = null;
  serverResourcesCache[event.fileName] = null;
}

function alertToUpdate() {
  if (!showTips) {
    return;
  }

  let msg = "Saving to local won't sync the remote. Try ever publish";
  let option = "Ignore";
  vscode.window.showWarningMessage(msg, option).then(result => {
    if (result === option) {
      showTips = false;
    }
  });
}

// this method is called when your extension is deactivated
function deactivate() { }
exports.deactivate = deactivate;

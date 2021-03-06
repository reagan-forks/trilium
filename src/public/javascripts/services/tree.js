import contextMenuService from './context_menu.js';
import dragAndDropSetup from './drag_and_drop.js';
import linkService from './link.js';
import messagingService from './messaging.js';
import noteDetailService from './note_detail.js';
import protectedSessionHolder from './protected_session_holder.js';
import treeChangesService from './branches.js';
import treeUtils from './tree_utils.js';
import utils from './utils.js';
import server from './server.js';
import treeCache from './tree_cache.js';
import infoService from "./info.js";
import treeBuilder from "./tree_builder.js";
import treeKeyBindings from "./tree_keybindings.js";
import Branch from '../entities/branch.js';
import NoteShort from '../entities/note_short.js';

const $tree = $("#tree");
const $createTopLevelNoteButton = $("#create-top-level-note-button");
const $collapseTreeButton = $("#collapse-tree-button");
const $scrollToCurrentNoteButton = $("#scroll-to-current-note-button");
const $notePathList = $("#note-path-list");
const $notePathCount = $("#note-path-count");

let startNotePath = null;

// note that if you want to access data like noteId or isProtected, you need to go into "data" property
function getCurrentNode() {
    return $tree.fancytree("getActiveNode");
}

function getCurrentNotePath() {
    const node = getCurrentNode();

    return treeUtils.getNotePath(node);
}

async function getNodesByBranchId(branchId) {
    utils.assertArguments(branchId);

    const branch = await treeCache.getBranch(branchId);

    return getNodesByNoteId(branch.noteId).filter(node => node.data.branchId === branchId);
}

function getNodesByNoteId(noteId) {
    utils.assertArguments(noteId);

    const list = getTree().getNodesByRef(noteId);
    return list ? list : []; // if no nodes with this refKey are found, fancy tree returns null
}

async function setPrefix(branchId, prefix) {
    utils.assertArguments(branchId);

    const branch = await treeCache.getBranch(branchId);

    branch.prefix = prefix;

    for (const node of await getNodesByBranchId(branchId)) {
        await setNodeTitleWithPrefix(node);
    }
}

async function setNodeTitleWithPrefix(node) {
    const noteTitle = await treeUtils.getNoteTitle(node.data.noteId);
    const branch = await treeCache.getBranch(node.data.branchId);

    const prefix = branch.prefix;

    const title = (prefix ? (prefix + " - ") : "") + noteTitle;

    node.setTitle(utils.escapeHtml(title));
}

async function expandToNote(notePath, expandOpts) {
    utils.assertArguments(notePath);

    const runPath = await getRunPath(notePath);

    const noteId = treeUtils.getNoteIdFromNotePath(notePath);

    let parentNoteId = 'none';

    for (const childNoteId of runPath) {
        const node = getNodesByNoteId(childNoteId).find(node => node.data.parentNoteId === parentNoteId);

        if (!node) {
            console.log(`Can't find node for noteId=${childNoteId} with parentNoteId=${parentNoteId}`);
        }

        if (childNoteId === noteId) {
            return node;
        }
        else {
            await node.setExpanded(true, expandOpts);
        }

        parentNoteId = childNoteId;
    }
}

async function activateNote(notePath, newNote) {
    utils.assertArguments(notePath);

    const node = await expandToNote(notePath);

    if (newNote) {
        noteDetailService.newNoteCreated();
    }

    // we use noFocus because when we reload the tree because of background changes
    // we don't want the reload event to steal focus from whatever was focused before
    await node.setActive(true, { noFocus: true });

    clearSelectedNodes();

    return node;
}

/**
 * Accepts notePath and tries to resolve it. Part of the path might not be valid because of note moving (which causes
 * path change) or other corruption, in that case this will try to get some other valid path to the correct note.
 */
async function getRunPath(notePath) {
    utils.assertArguments(notePath);

    const path = notePath.split("/").reverse();

    if (!path.includes("root")) {
        path.push('root');
    }

    const effectivePath = [];
    let childNoteId = null;
    let i = 0;

    while (true) {
        if (i >= path.length) {
            break;
        }

        const parentNoteId = path[i++];

        if (childNoteId !== null) {
            const child = await treeCache.getNote(childNoteId);
            const parents = await child.getParentNotes();

            if (!parents) {
                messagingService.logError("No parents found for " + childNoteId);
                return;
            }

            if (!parents.some(p => p.noteId === parentNoteId)) {
                console.log(utils.now(), "Did not find parent " + parentNoteId + " for child " + childNoteId);

                if (parents.length > 0) {
                    console.log(utils.now(), "Available parents:", parents);

                    const someNotePath = await getSomeNotePath(parents[0]);

                    if (someNotePath) { // in case it's root the path may be empty
                        const pathToRoot = someNotePath.split("/").reverse();

                        for (const noteId of pathToRoot) {
                            effectivePath.push(noteId);
                        }

                        effectivePath.push('root');
                    }

                    break;
                }
                else {
                    messagingService.logError("No parents, can't activate node.");
                    return;
                }
            }
        }

        if (parentNoteId === 'none') {
            break;
        }
        else {
            effectivePath.push(parentNoteId);
            childNoteId = parentNoteId;
        }
    }

    return effectivePath.reverse();
}

async function showPaths(noteId, node) {
    utils.assertArguments(noteId, node);

    const note = await treeCache.getNote(noteId);
    const parents = await note.getParentNotes();

    $notePathCount.html(parents.length + " path" + (parents.length > 0 ? "s" : ""));

    $notePathList.empty();

    for (const parentNote of parents) {
        const parentNotePath = await getSomeNotePath(parentNote);
        // this is to avoid having root notes leading '/'
        const notePath = parentNotePath ? (parentNotePath + '/' + noteId) : noteId;
        const title = await treeUtils.getNotePathTitle(notePath);

        const noteLink = await linkService.createNoteLink(notePath, title);

        noteLink.addClass("no-tooltip-preview");

        const item = $("<li/>").append(noteLink);

        if (node.getParent().data.noteId === parentNote.noteId) {
            item.addClass("current");
        }

        $notePathList.append(item);
    }
}

async function getSomeNotePath(note) {
    utils.assertArguments(note);

    const path = [];

    let cur = note;

    while (cur.noteId !== 'root') {
        path.push(cur.noteId);

        const parents = await cur.getParentNotes();

        if (!parents.length) {
            infoService.throwError("Can't find parents for " + cur);
        }

        cur = parents[0];
    }

    return path.reverse().join('/');
}

async function setExpandedToServer(branchId, isExpanded) {
    utils.assertArguments(branchId);

    const expandedNum = isExpanded ? 1 : 0;

    await server.put('branches/' + branchId + '/expanded/' + expandedNum);
}

function addRecentNote(branchId, notePath) {
    setTimeout(async () => {
        // we include the note into recent list only if the user stayed on the note at least 5 seconds
        if (notePath && notePath === getCurrentNotePath()) {
            await server.put('recent-notes/' + branchId + '/' + encodeURIComponent(notePath));
        }
    }, 1500);
}

function setCurrentNotePathToHash(node) {
    utils.assertArguments(node);

    const currentNotePath = treeUtils.getNotePath(node);
    const currentBranchId = node.data.branchId;

    document.location.hash = currentNotePath;

    addRecentNote(currentBranchId, currentNotePath);
}

function getSelectedNodes(stopOnParents = false) {
    return getTree().getSelectedNodes(stopOnParents);
}

function clearSelectedNodes() {
    for (const selectedNode of getSelectedNodes()) {
        selectedNode.setSelected(false);
    }

    const currentNode = getCurrentNode();

    if (currentNode) {
        currentNode.setSelected(true);
    }
}

async function treeInitialized() {
    const noteId = treeUtils.getNoteIdFromNotePath(startNotePath);

    if (!await treeCache.getNote(noteId)) {
        // note doesn't exist so don't try to activate it
        startNotePath = null;
    }

    if (startNotePath) {
        const node = await activateNote(startNotePath);

        // looks like this this doesn't work when triggered immediatelly after activating node
        // so waiting a second helps
        setTimeout(() => node.makeVisible({scrollIntoView: true}), 1000);
    }
}

function initFancyTree(tree) {
    utils.assertArguments(tree);

    $tree.fancytree({
        autoScroll: true,
        keyboard: false, // we takover keyboard handling in the hotkeys plugin
        extensions: ["hotkeys", "filter", "dnd", "clones"],
        source: tree,
        scrollParent: $tree,
        minExpandLevel: 2, // root can't be collapsed
        click: (event, data) => {
            const targetType = data.targetType;
            const node = data.node;

            if (targetType === 'title' || targetType === 'icon') {
                if (!event.ctrlKey) {
                    node.setActive();
                    node.setSelected(true);

                    clearSelectedNodes();
                }
                else {
                    node.setSelected(!node.isSelected());
                }

                return false;
            }
        },
        activate: (event, data) => {
            const node = data.node.data;

            setCurrentNotePathToHash(data.node);

            noteDetailService.switchToNote(node.noteId);

            showPaths(node.noteId, data.node);
        },
        expand: (event, data) => setExpandedToServer(data.node.data.branchId, true),
        collapse: (event, data) => setExpandedToServer(data.node.data.branchId, false),
        init: (event, data) => treeInitialized(), // don't collapse to short form
        hotkeys: {
            keydown: treeKeyBindings
        },
        filter: {
            autoApply: true,   // Re-apply last filter if lazy data is loaded
            autoExpand: true, // Expand all branches that contain matches while filtered
            counter: false,     // Show a badge with number of matching child nodes near parent icons
            fuzzy: false,      // Match single characters in order, e.g. 'fb' will match 'FooBar'
            hideExpandedCounter: true,  // Hide counter badge if parent is expanded
            hideExpanders: false,       // Hide expanders if all child nodes are hidden by filter
            highlight: true,   // Highlight matches by wrapping inside <mark> tags
            leavesOnly: false, // Match end nodes only
            nodata: true,      // Display a 'no data' status node if result is empty
            mode: "hide"       // Grayout unmatched nodes (pass "hide" to remove unmatched node instead)
        },
        dnd: dragAndDropSetup,
        lazyLoad: function(event, data) {
            const noteId = data.node.data.noteId;

            data.result = treeCache.getNote(noteId).then(note => treeBuilder.prepareBranch(note));
        },
        clones: {
            highlightActiveClones: true
        }
    });

    $tree.contextmenu(contextMenuService.contextMenuOptions);
}

function getTree() {
    return $tree.fancytree('getTree');
}

async function reload() {
    const notes = await loadTree();

    // this will also reload the note content
    await getTree().reload(notes);
}

function getNotePathFromAddress() {
    return document.location.hash.substr(1); // strip initial #
}

async function loadTree() {
    const resp = await server.get('tree');
    startNotePath = resp.startNotePath;

    if (document.location.hash) {
        startNotePath = getNotePathFromAddress();
    }

    return await treeBuilder.prepareTree(resp.notes, resp.branches, resp.relations);
}

function collapseTree(node = null) {
    if (!node) {
        node = $tree.fancytree("getRootNode");
    }

    node.setExpanded(false);

    node.visit(node => node.setExpanded(false));
}

function scrollToCurrentNote() {
    const node = getCurrentNode();

    if (node) {
        node.makeVisible({scrollIntoView: true});

        node.setFocus();
    }
}

function setBranchBackgroundBasedOnProtectedStatus(noteId) {
    getNodesByNoteId(noteId).map(node => node.toggleClass("protected", node.data.isProtected));
}

function setProtected(noteId, isProtected) {
    getNodesByNoteId(noteId).map(node => node.data.isProtected = isProtected);

    setBranchBackgroundBasedOnProtectedStatus(noteId);
}

async function setNoteTitle(noteId, title) {
    utils.assertArguments(noteId);

    const note = await treeCache.getNote(noteId);

    note.title = title;

    for (const clone of getNodesByNoteId(noteId)) {
        await setNodeTitleWithPrefix(clone);
    }
}

async function createNewTopLevelNote() {
    const rootNode = getNodesByNoteId('root')[0];

    await createNote(rootNode, "root", "into");
}

async function createNote(node, parentNoteId, target, isProtected) {
    utils.assertArguments(node, parentNoteId, target);

    // if isProtected isn't available (user didn't enter password yet), then note is created as unencrypted
    // but this is quite weird since user doesn't see WHERE the note is being created so it shouldn't occur often
    if (!isProtected || !protectedSessionHolder.isProtectedSessionAvailable()) {
        isProtected = false;
    }

    const newNoteName = "new note";

    const {note, branch} = await server.post('notes/' + parentNoteId + '/children', {
        title: newNoteName,
        target: target,
        target_branchId: node.data.branchId,
        isProtected: isProtected
    });

    const noteEntity = new NoteShort(treeCache, note);
    const branchEntity = new Branch(treeCache, branch);

    treeCache.add(noteEntity, branchEntity);

    noteDetailService.newNoteCreated();

    const newNode = {
        title: newNoteName,
        noteId: branchEntity.noteId,
        parentNoteId: parentNoteId,
        refKey: branchEntity.noteId,
        branchId: branchEntity.branchId,
        isProtected: isProtected,
        extraClasses: await treeBuilder.getExtraClasses(noteEntity)
    };

    if (target === 'after') {
        await node.appendSibling(newNode).setActive(true);
    }
    else if (target === 'into') {
        if (!node.getChildren() && node.isFolder()) {
            await node.setExpanded();
        }
        else {
            node.addChildren(newNode);
        }

        await node.getLastChild().setActive(true);

        node.folder = true;
        node.renderTitle();
    }
    else {
        infoService.throwError("Unrecognized target: " + target);
    }

    clearSelectedNodes(); // to unmark previously active node

    infoService.showMessage("Created!");
}

async function sortAlphabetically(noteId) {
    await server.put('notes/' + noteId + '/sort');

    await reload();
}

async function showTree() {
    const tree = await loadTree();

    initFancyTree(tree);
}

messagingService.subscribeToMessages(message => {
   if (message.type === 'refresh-tree') {
       reload();
   }
});

messagingService.subscribeToSyncMessages(syncData => {
    if (syncData.some(sync => sync.entityName === 'branches')
        || syncData.some(sync => sync.entityName === 'notes')) {

        console.log(utils.now(), "Reloading tree because of background changes");

        reload();
    }
});

utils.bindShortcut('ctrl+o', () => {
    const node = getCurrentNode();
    const parentNoteId = node.data.parentNoteId;
    const isProtected = treeUtils.getParentProtectedStatus(node);

    createNote(node, parentNoteId, 'after', isProtected);
});

utils.bindShortcut('ctrl+p', () => {
    const node = getCurrentNode();

    createNote(node, node.data.noteId, 'into', node.data.isProtected);
});

utils.bindShortcut('ctrl+del', () => {
    const node = getCurrentNode();

    treeChangesService.deleteNodes([node]);
});

utils.bindShortcut('ctrl+.', scrollToCurrentNote);

$(window).bind('hashchange', function() {
    const notePath = getNotePathFromAddress();

    if (getCurrentNotePath() !== notePath) {
        console.log("Switching to " + notePath + " because of hash change");

        activateNote(notePath);
    }
});

utils.bindShortcut('alt+c', () => collapseTree()); // don't use shortened form since collapseTree() accepts argument
$collapseTreeButton.click(() => collapseTree());

$createTopLevelNoteButton.click(createNewTopLevelNote);
$scrollToCurrentNoteButton.click(scrollToCurrentNote);

export default {
    reload,
    collapseTree,
    scrollToCurrentNote,
    setBranchBackgroundBasedOnProtectedStatus,
    setProtected,
    expandToNote,
    activateNote,
    getCurrentNode,
    getCurrentNotePath,
    setCurrentNotePathToHash,
    setNoteTitle,
    setPrefix,
    createNewTopLevelNote,
    createNote,
    getSelectedNodes,
    clearSelectedNodes,
    sortAlphabetically,
    showTree
};
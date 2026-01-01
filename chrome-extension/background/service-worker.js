// Save to Thymer - Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'save-to-thymer',
        title: 'Save to Thymer',
        contexts: ['page', 'selection', 'link', 'image']
    });
});

// Note: Context menu clicks cannot open the popup in MV3 service workers.
// chrome.action.openPopup() only works from user gesture in popup context.
// Users must click the extension icon or use the keyboard shortcut.

chrome.commands.onCommand.addListener((command) => {
    if (command === 'quick_save') {
        chrome.action.openPopup();
    }
});

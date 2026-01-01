// Save to Thymer - Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'save-to-thymer',
        title: 'Save to Thymer',
        contexts: ['page', 'selection', 'link', 'image']
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'save-to-thymer') {
        chrome.action.openPopup();
    }
});

chrome.commands.onCommand.addListener((command) => {
    if (command === 'quick_save') {
        chrome.action.openPopup();
    }
});

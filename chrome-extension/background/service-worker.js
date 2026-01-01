// Save to Thymer - Background Service Worker

chrome.commands.onCommand.addListener((command) => {
    if (command === 'quick_save') {
        chrome.action.openPopup();
    }
});

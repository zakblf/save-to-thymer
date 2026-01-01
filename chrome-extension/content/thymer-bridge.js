(function () {
    if (window.__saveToThymerBridge) return;
    window.__saveToThymerBridge = true;

    const pending = new Map();
    let msgId = 0;

    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
        if (msg.source !== 'save-to-thymer') return;
        const id = `stt-${++msgId}`;
        pending.set(id, { respond, timer: setTimeout(() => { pending.delete(id); respond({ error: 'Timeout' }); }, 10000) });
        window.postMessage({ type: msg.type, messageId: id, payload: msg.payload, collectionGuid: msg.collectionGuid, source: 'save-to-thymer-bridge' }, '*');
        return true;
    });

    window.addEventListener('message', e => {
        if (e.source !== window || e.data?.source !== 'thymer-plugin-stt') return;
        const req = pending.get(e.data.messageId);
        if (req) {
            clearTimeout(req.timer);
            req.respond(e.data.response);
            pending.delete(e.data.messageId);
        }
    });
})();

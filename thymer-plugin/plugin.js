class Plugin extends AppPlugin {
    onLoad() {
        this.collectionCache = null;
        this.collectionCacheTime = 0;
        this.setupMessageListener();
    }

    onUnload() {
        if (this.messageHandler) window.removeEventListener('message', this.messageHandler);
    }

    setupMessageListener() {
        this.messageHandler = async e => {
            if (e.source !== window || e.data?.source !== 'save-to-thymer-bridge') return;
            const { type, messageId, payload, collectionGuid } = e.data;
            let response = { error: 'Unknown message type' };

            try {
                if (type === 'THYMER_PING') response = { connected: true };
                else if (type === 'THYMER_GET_COLLECTIONS') response = await this.getCollections();
                else if (type === 'THYMER_GET_COLLECTION_FIELDS') response = await this.getFields(collectionGuid);
                else if (type === 'THYMER_SAVE_RECORD') response = await this.saveRecord(payload);
                else if (type === 'THYMER_GET_TEMPLATES') response = this.getTemplates();
                else if (type === 'THYMER_SAVE_TEMPLATES') response = await this.saveTemplates(payload);
            } catch (err) {
                response = { error: err.message };
            }

            window.postMessage({ messageId, response, source: 'thymer-plugin-stt' }, '*');
        };
        window.addEventListener('message', this.messageHandler);
    }

    async getCollections() {
        // Cache collections for 5 seconds to speed up consecutive calls
        if (!this.collectionCache || Date.now() - this.collectionCacheTime > 5000) {
            this.collectionCache = await this.data.getAllCollections();
            this.collectionCacheTime = Date.now();
        }
        return { collections: this.collectionCache.map(c => ({ guid: c.getGuid(), name: c.getConfiguration().name })) };
    }

    async findCollection(guid) {
        if (!this.collectionCache) await this.getCollections();
        return this.collectionCache.find(c => c.getGuid() === guid);
    }

    getTemplates() {
        const config = this.getConfiguration();
        return { templates: config.custom?.templates || [] };
    }

    async saveTemplates({ templates }) {
        const config = this.getConfiguration();
        config.custom = config.custom || {};
        config.custom.templates = templates;
        await this.data.getPluginByGuid(this.getGuid()).saveConfiguration(config);
        return { success: true };
    }

    async getFields(collectionGuid) {
        const col = await this.findCollection(collectionGuid);
        if (!col) return { fields: [] };

        const config = col.getConfiguration();
        return {
            fields: (config.fields || [])
                .filter(f => f.active && !['created_at', 'updated_at', 'icon'].includes(f.id) && f.type !== 'icon' && f.label?.toLowerCase() !== 'icon')
                .map(f => ({ id: f.id, label: f.label, type: f.type, choices: f.choices?.filter(c => c.active).map(c => ({ id: c.id, label: c.label })) }))
        };
    }

    async saveRecord({ collectionGuid, title, pageUrl, properties, bannerUrl, bodyMarkdown, selectedText, tags, saveAsTodo, addToday }) {
        console.log('[SaveToThymer] saveRecord v2 called with pageUrl:', pageUrl);
        const col = await this.findCollection(collectionGuid);
        if (!col) return { error: 'Collection not found' };

        const config = col.getConfiguration();
        const fieldsById = new Map((config.fields || []).map(f => [f.id, f]));
        const records = await col.getAllRecords();

        // Deduplication: search for existing record with same URL (fail-safe)
        let record = null;
        let isExisting = false;
        console.log('[SaveToThymer] Dedup: pageUrl=', pageUrl);
        console.log('[SaveToThymer] Dedup: records count=', records.length);
        console.log('[SaveToThymer] Dedup: fields=', (config.fields || []).map(f => ({ id: f.id, type: f.type, label: f.label })));
        if (pageUrl) {
            try {
                for (const r of records) {
                    for (const f of config.fields || []) {
                        if (['url', 'link'].includes(f.type) || f.label?.toLowerCase() === 'url') {
                            try {
                                const prop = r.prop(f.label) || r.prop(f.id);
                                // Use text() method - that's how Thymer SDK exposes string values
                                const val = prop?.text?.();
                                console.log('[SaveToThymer] Dedup: record', r.guid, 'field', f.label, 'final val=', val);
                                if (val && val === pageUrl) {
                                    console.log('[SaveToThymer] Dedup: MATCH FOUND!');
                                    record = r;
                                    isExisting = true;
                                    break;
                                }
                            } catch (e) { console.log('[SaveToThymer] Dedup: prop error', e); }
                        }
                    }
                    if (record) break;
                }
            } catch (err) {
                console.error('[SaveToThymer] Deduplication error:', err);
            }
        }
        console.log('[SaveToThymer] Dedup: result isExisting=', isExisting);

        // Create new record if no duplicate found
        if (!record) {
            const newGuid = col.createRecord(title);
            if (!newGuid) return { error: 'Failed to create record' };
            // Re-fetch records since the array is now stale
            const freshRecords = await col.getAllRecords();
            record = freshRecords.find(r => r.guid === newGuid);
            if (!record) return { error: 'Record not found' };
        }

        if (bannerUrl) {
            const bannerField = (config.fields || []).find(f => f.type === 'banner' && f.active);
            if (bannerField) {
                const prop = record.prop(bannerField.label) || record.prop(bannerField.id);
                if (prop) prop.set({ name: `${title} Cover`, imgUrl: bannerUrl });
            }
        }

        for (const [fieldId, value] of Object.entries(properties || {})) {
            if (!value || fieldId === 'title') continue;
            const field = fieldsById.get(fieldId);
            if (!field) continue;
            const prop = record.prop(field.label) || record.prop(fieldId);
            if (!prop) continue;
            if (field.type === 'number') {
                const num = parseFloat(value);
                if (!isNaN(num)) prop.set(num);
            } else if (field.type !== 'banner') {
                prop.set(String(value));
            }
        }

        if (typeof record.createLineItem === 'function') {
            if (selectedText) {
                // Selection mode: header line with nested quotes
                const headerItem = await this.insertHeaderLine(record, title, tags, saveAsTodo);
                await this.insertQuoteBlock(record, selectedText, headerItem);
            } else if (bodyMarkdown) {
                await this.insertMarkdown(record, bodyMarkdown);
            }
        }

        const msg = isExisting ? `Updated "${title}" in ${config.name}` : `"${title}" added to ${config.name}`;
        this.ui.addToaster({ title: 'Saved!', message: msg, dismissible: true, autoDestroyTime: 2500 });

        return { success: true, recordGuid: record.guid };
    }

    async insertHeaderLine(record, title, tags, saveAsTodo) {
        try {
            const itemType = saveAsTodo ? 'task' : 'text';
            const item = await record.createLineItem(null, null, itemType);
            if (!item) return null;

            const segments = [{ type: 'text', text: title }];

            if (tags) {
                const tagList = tags.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean);
                for (const tag of tagList) {
                    segments.push({ type: 'text', text: ' ' });
                    segments.push({ type: 'hashtag', text: '#' + tag });
                }
            }

            item.setSegments(segments);
            return item;
        } catch (err) {
            console.error('[SaveToThymer] insertHeaderLine error:', err);
            return null;
        }
    }

    async insertQuoteBlock(record, text, parentItem) {
        const lines = text.split('\n').filter(line => line.trim());
        let lastItem = null;

        for (const line of lines) {
            try {
                const item = await record.createLineItem(parentItem, lastItem, 'quote');
                if (item) {
                    item.setSegments([{ type: 'text', text: line.trim() }]);
                    lastItem = item;
                }
            } catch (err) {
                console.error('[SaveToThymer] insertQuoteBlock error:', err);
            }
        }
    }

    async insertMarkdown(record, markdown) {
        const blocks = this.parseMarkdown(markdown);
        let lastItem = null;

        for (const block of blocks) {
            try {
                const item = await record.createLineItem(null, lastItem, block.type);
                if (item) {
                    if (block.type === 'heading' && block.hsize) item.setHeadingSize(block.hsize);
                    if (block.type === 'block' && block.codeLines) {
                        if (block.language) item.setHighlightLanguage(block.language);
                        item.setSegments([]);
                        let lastChild = null;
                        for (const line of block.codeLines) {
                            const child = await record.createLineItem(item, lastChild, 'text');
                            if (child) { child.setSegments([{ type: 'text', text: line }]); lastChild = child; }
                        }
                    } else if (block.segments?.length) {
                        item.setSegments(block.segments);
                    } else {
                        item.setSegments([]);
                    }
                    lastItem = item;
                }
            } catch (err) {
                console.error('[SaveToThymer] Failed to create line item');
            }
        }
    }

    parseMarkdown(markdown) {
        const lines = markdown.split('\n');
        const blocks = [];
        let inCode = false, codeLines = [], codeLang = '';

        for (const line of lines) {
            if (line.startsWith('```')) {
                if (!inCode) { inCode = true; codeLang = line.slice(3).trim(); codeLines = []; }
                else { inCode = false; if (codeLines.length) blocks.push({ type: 'block', language: codeLang || 'plaintext', codeLines }); codeLines = []; codeLang = ''; }
                continue;
            }
            if (inCode) { codeLines.push(line); continue; }
            const parsed = this.parseLine(line);
            if (parsed) blocks.push(parsed);
        }
        if (inCode && codeLines.length) blocks.push({ type: 'block', language: codeLang || 'plaintext', codeLines });
        return blocks;
    }

    parseLine(line) {
        if (!line.trim()) return { type: 'text', segments: [{ type: 'text', text: ' ' }] };
        if (/^(\*\s*\*\s*\*|\-\s*\-\s*\-|_\s*_\s*_)[\s\*\-_]*$/.test(line.trim())) return { type: 'br', segments: [] };

        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) return { type: 'heading', hsize: heading[1].length, segments: this.parseInline(heading[2]) };

        const task = line.match(/^[\-\*]\s+\[([ xX])\]\s+(.+)$/);
        if (task) return { type: 'task', segments: this.parseInline(task[2]) };

        const ul = line.match(/^[\-\*]\s+(.+)$/);
        if (ul) return { type: 'ulist', segments: this.parseInline(ul[1]) };

        const ol = line.match(/^\d+\.\s+(.+)$/);
        if (ol) return { type: 'olist', segments: this.parseInline(ol[1]) };

        if (line.startsWith('> ')) return { type: 'quote', segments: this.parseInline(line.slice(2)) };

        return { type: 'text', segments: this.parseInline(line) };
    }

    parseInline(text) {
        const segments = [];
        const patterns = [
            { r: /`([^`]+)`/, t: 'code' },
            { r: /\[([^\]]+)\]\(([^)]+)\)/, t: 'link' },
            { r: /\*\*([^*]+)\*\*/, t: 'bold' },
            { r: /__([^_]+)__/, t: 'bold' },
            { r: /\*([^*]+)\*/, t: 'italic' },
            { r: /_([^_]+)_/, t: 'italic' }
        ];
        let remaining = text;

        while (remaining.length) {
            let earliest = null, idx = remaining.length, pattern = null;
            for (const p of patterns) {
                const m = remaining.match(p.r);
                if (m && m.index < idx) { earliest = m; idx = m.index; pattern = p; }
            }
            if (earliest && pattern) {
                if (idx > 0) segments.push({ type: 'text', text: remaining.slice(0, idx) });
                segments.push({ type: pattern.t === 'link' ? 'text' : pattern.t, text: earliest[1] });
                remaining = remaining.slice(idx + earliest[0].length);
            } else {
                segments.push({ type: 'text', text: remaining });
                break;
            }
        }
        return segments.length ? segments : [{ type: 'text', text }];
    }
}

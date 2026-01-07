class SaveToThymer {
    static MSG = {
        PING: 'PING',
        GET_PAGE_DATA: 'GET_PAGE_DATA',
        THYMER_PING: 'THYMER_PING',
        THYMER_GET_COLLECTIONS: 'THYMER_GET_COLLECTIONS',
        THYMER_GET_COLLECTION_FIELDS: 'THYMER_GET_COLLECTION_FIELDS',
        THYMER_SAVE_RECORD: 'THYMER_SAVE_RECORD'
    };

    constructor() {
        this.connected = false;
        this.pageData = null;
        this.templates = [];
        this.currentTemplate = null;
        this.collections = [];
        this.fields = [];
        this.thymerTabId = null;
        this.sourceTabId = null;
        this.draggedIndex = null;
        this.init();
    }

    async init() {
        await this.loadTemplates();
        await this.getPageData();
        this.bindEvents();
        this.initDragAndDrop();
        await this.connect();
        this.renderTemplates();
    }

    async loadTemplates() {
        const { templates } = await chrome.storage.sync.get('templates');
        this.templates = templates || [];
    }

    async saveTemplates() {
        await chrome.storage.sync.set({ templates: this.templates });
    }

    async getPageData() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) return this.setDefaultPageData();
            this.sourceTabId = tab.id;
            this.sourceWindowId = tab.windowId;

            let needsInjection = false;
            try {
                await chrome.tabs.sendMessage(tab.id, { type: SaveToThymer.MSG.PING });
            } catch {
                needsInjection = true;
            }

            if (needsInjection) {
                await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
                await this.wait(300);
            }

            this.pageData = await chrome.tabs.sendMessage(tab.id, { type: SaveToThymer.MSG.GET_PAGE_DATA }) || this.setDefaultPageData(tab);
        } catch {
            this.setDefaultPageData();
        }
    }

    setDefaultPageData(tab = {}) {
        this.pageData = { title: tab.title || 'Untitled', url: tab.url || '', images: [], ogImage: null, description: '', bodyMarkdown: '' };
        return this.pageData;
    }

    wait(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    async connect(retries = 3) {
        const status = document.getElementById('connection-status');
        const text = status.querySelector('.status-text');

        for (let i = 1; i <= retries; i++) {
            text.textContent = `Connecting to Thymer...`;
            try {
                const tabs = await chrome.tabs.query({ url: 'https://*.thymer.com/*' });
                if (!tabs.length) throw new Error('No Thymer tab');
                this.thymerTabId = tabs[0].id;
                try {
                    await chrome.scripting.executeScript({ target: { tabId: this.thymerTabId }, files: ['content/thymer-bridge.js'] });
                    await this.wait(200);
                } catch { }
                const res = await chrome.tabs.sendMessage(this.thymerTabId, { type: SaveToThymer.MSG.THYMER_PING, source: 'save-to-thymer' });
                if (res?.connected) {
                    status.className = 'header-status connected';
                    text.textContent = 'Connected to Thymer';
                    this.connected = true;
                    this.collections = (await this.send({ type: SaveToThymer.MSG.THYMER_GET_COLLECTIONS }))?.collections || [];
                    return;
                }
            } catch { }
            if (i < retries) await this.wait(500);
        }
        status.className = 'header-status error';
        text.textContent = 'Not connected to Thymer';
        this.connected = false;
    }

    async send(msg) {
        if (!this.thymerTabId) throw new Error('Not connected');
        return chrome.tabs.sendMessage(this.thymerTabId, { ...msg, source: 'save-to-thymer' });
    }

    async getFields(guid) {
        const res = await this.send({ type: SaveToThymer.MSG.THYMER_GET_COLLECTION_FIELDS, collectionGuid: guid });
        return (res?.fields || []).filter(f => f.type !== 'icon' && f.id !== 'icon' && f.label?.toLowerCase() !== 'icon');
    }

    escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    isSafeUrl(url) {
        if (!url) return false;
        try {
            const parsed = new URL(url);
            return ['http:', 'https:', 'data:'].includes(parsed.protocol);
        } catch {
            return false;
        }
    }

    $(id) {
        return document.getElementById(id);
    }

    bindEvents() {
        this.$('reconnect-btn').onclick = () => { this.connected = false; this.thymerTabId = null; this.connect(); };
        this.$('settings-btn').onclick = () => this.showView('settings-view');
        this.$('settings-back-btn').onclick = () => this.showView('template-selector');
        this.$('export-btn').onclick = () => this.exportTemplates();
        this.$('import-btn').onclick = () => this.$('import-file').click();
        this.$('import-file').onchange = e => this.importTemplates(e);
        this.$('add-template-btn').onclick = () => this.editTemplate(null);
        this.$('back-btn').onclick = () => this.showView('template-selector');
        this.$('save-btn').onclick = () => this.save();
        this.$('editor-back-btn').onclick = () => this.showView('template-selector');
        this.$('delete-template-btn').onclick = () => this.deleteTemplate();
        this.$('save-template-btn').onclick = () => this.saveTemplate();
        this.$('edit-template-btn').onclick = () => this.editTemplate(this.currentTemplate);
        this.$('editor-collection').onchange = async e => {
            this.fields = e.target.value ? await this.getFields(e.target.value) : [];
            this.renderMappings();
        };
    }

    showView(id) {
        document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id));
    }

    initDragAndDrop() {
        const container = this.$('templates-list');

        container.addEventListener('dragstart', e => {
            const item = e.target.closest('.template-item');
            if (!item) return;
            this.draggedIndex = parseInt(item.dataset.i, 10);
            setTimeout(() => item.classList.add('dragging'), 0);
            e.dataTransfer.effectAllowed = 'move';
        });

        container.addEventListener('dragover', e => {
            e.preventDefault();
            const dragging = container.querySelector('.dragging');
            if (!dragging) return;
            const siblings = [...container.querySelectorAll('.template-item:not(.dragging)')];
            const next = siblings.find(s => e.clientY < s.getBoundingClientRect().top + s.getBoundingClientRect().height / 2);
            next ? container.insertBefore(dragging, next) : container.appendChild(dragging);
        });

        container.addEventListener('dragend', async e => {
            const item = e.target.closest('.template-item');
            if (!item) return;
            item.classList.remove('dragging');
            const items = [...container.querySelectorAll('.template-item')];
            const newIdx = items.indexOf(item);
            if (this.draggedIndex !== null && newIdx !== this.draggedIndex) {
                const moved = this.templates.splice(this.draggedIndex, 1)[0];
                this.templates.splice(newIdx, 0, moved);
                await this.saveTemplates();
                this.renderTemplates();
            }
            this.draggedIndex = null;
        });
    }

    renderTemplates() {
        const el = this.$('templates-list');
        if (!this.templates.length) {
            el.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><p>No templates yet</p></div>';
            return;
        }
        el.innerHTML = this.templates.map((t, i) => `
            <div class="template-item" data-i="${i}" draggable="true">
                <div class="template-item-handle"><svg viewBox="0 0 256 256" fill="currentColor"><path d="M108,60A16,16,0,1,1,92,44,16,16,0,0,1,108,60Zm56,16a16,16,0,1,0-16-16A16,16,0,0,0,164,76ZM92,112a16,16,0,1,0,16,16A16,16,0,0,0,92,112Zm72,0a16,16,0,1,0,16,16A16,16,0,0,0,164,112ZM92,180a16,16,0,1,0,16,16A16,16,0,0,0,92,180Zm72,0a16,16,0,1,0,16,16A16,16,0,0,0,164,180Z"/></svg></div>
                <div class="template-item-content">
                    <div class="template-item-info"><span class="template-item-name">${this.escapeHtml(t.name)}</span><span class="template-item-collection">${this.escapeHtml(t.collectionName || '')}</span></div>
                    <div class="template-item-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
                </div>
            </div>`).join('');
        el.querySelectorAll('.template-item').forEach(item => {
            item.onclick = e => { if (!e.target.closest('.template-item-handle')) this.selectTemplate(this.templates[+item.dataset.i]); };
        });
    }

    selectTemplate(template) {
        this.currentTemplate = template;
        this.selectedBanner = this.pageData?.ogImage;
        this.$('template-name').textContent = template.name;
        this.$('preview-title').value = this.pageData?.title || '';
        this.$('preview-url').value = this.pageData?.url || '';
        this.renderPropertyFields(template);
        this.showView('save-view');
    }

    renderPropertyFields(template) {
        const el = this.$('property-fields');
        const editable = (template.mappings || []).filter(m => !['page-title', 'page-url', 'page-image', 'page-description'].includes(m.source));
        const hasBanner = (template.mappings || []).some(m => m.source === 'page-image');
        const bannerUrl = this.selectedBanner;

        let html = '';

        if (hasBanner && bannerUrl) {
            html += `<div class="field-group">
                <label class="field-label">Banner Image</label>
                <div class="image-preview-wrapper" data-target="banner">
                    <img src="${bannerUrl}" class="banner-preview" id="banner-preview-img" alt="Banner">
                    <div class="image-overlay"><svg viewBox="0 0 256 256" fill="currentColor"><path d="M232.49,55.51l-32-32a12,12,0,0,0-17,0l-96,96A12,12,0,0,0,84,128v32a12,12,0,0,0,12,12h32a12,12,0,0,0,8.49-3.51l96-96A12,12,0,0,0,232.49,55.51ZM192,49l15,15L196,75,181,60Zm-69,99H108V133l56-56,15,15Zm105-7.43V208a20,20,0,0,1-20,20H48a20,20,0,0,1-20-20V48A20,20,0,0,1,48,28h67.43a12,12,0,0,1,0,24H52V204H204V140.57a12,12,0,0,1,24,0Z"/></svg></div>
                </div>
            </div>`;
        }

        if (template.clipContent) {
            html += '<div class="field-group"><label class="field-label">Body Content</label><input type="text" id="preview-body" class="field-input body-preview" readonly></div>';
        }

        if (!editable.length && !template.clipContent && !hasBanner) { el.innerHTML = ''; return; }

        html += editable.map(m => {
            if (m.source === 'static') {
                const val = m.fieldType === 'choice' && m.choices ? (m.choices.find(c => c.id === m.staticValue)?.label || m.staticValue) : m.staticValue || '';
                return `<div class="field-group"><label class="field-label">${m.fieldLabel}</label><input class="field-input" value="${val}" readonly style="color:#666"></div>`;
            }
            if (m.source === 'custom') {
                if (m.fieldType === 'choice' && m.choices) {
                    return `<div class="field-group"><label class="field-label">${m.fieldLabel}</label><select class="field-select" data-field-id="${m.fieldId}"><option value="">Select...</option>${m.choices.map(c => `<option value="${c.id}">${c.label}</option>`).join('')}</select></div>`;
                }
                return `<div class="field-group"><label class="field-label">${m.fieldLabel}</label><input class="field-input" data-field-id="${m.fieldId}" placeholder="Enter..."></div>`;
            }
            return '';
        }).join('');

        el.innerHTML = html;
        if (template.clipContent) {
            const bodyInput = this.$('preview-body');
            if (bodyInput) bodyInput.value = this.pageData?.bodyMarkdown || '';
        }

        el.querySelectorAll('.image-preview-wrapper').forEach(wrapper => {
            wrapper.onclick = () => this.showImageSelector(wrapper.dataset.target);
        });
    }

    showImageSelector(target) {
        const allImages = this.pageData?.images || [];
        const images = allImages.filter(img => !/loading|placeholder|spinner|lazy|transparent|blank|spacer/i.test(img));
        if (images.length <= 1) return;

        const existing = document.querySelector('.image-selector-backdrop');
        if (existing) existing.remove();

        const backdrop = document.createElement('div');
        backdrop.className = 'image-selector-backdrop';

        const popup = document.createElement('div');
        popup.className = 'image-selector-popup';
        popup.innerHTML = `
            <div class="image-selector-header">
                <span>Select Image</span>
                <button class="image-selector-close">×</button>
            </div>
            <div class="image-selector-grid">
                ${images.filter(img => this.isSafeUrl(img)).map(img => `<img src="${img}" class="image-selector-item" data-url="${img}">`).join('')}
            </div>
        `;

        backdrop.appendChild(popup);
        document.body.appendChild(backdrop);

        const close = () => backdrop.remove();
        backdrop.onclick = e => { if (e.target === backdrop) close(); };
        popup.querySelector('.image-selector-close').onclick = close;
        popup.querySelectorAll('.image-selector-item').forEach(img => {
            img.onclick = () => {
                const url = img.dataset.url;
                if (target === 'banner') {
                    this.selectedBanner = url;
                    this.$('banner-preview-img').src = url;
                }
                close();
            };
        });
    }

    async editTemplate(template) {
        this.currentTemplate = template;
        this.$('editor-title').textContent = template ? 'Edit Template' : 'New Template';
        this.$('delete-template-btn').style.display = template ? 'flex' : 'none';
        this.$('editor-template-name').value = template?.name || '';
        this.$('editor-body-source').value = template?.clipContent ? 'page-content' : '';

        const sel = this.$('editor-collection');
        sel.innerHTML = '<option value="">Select...</option>' + this.collections.map(c => `<option value="${c.guid}" ${template?.collectionGuid === c.guid ? 'selected' : ''}>${this.escapeHtml(c.name)}</option>`).join('');

        if (template?.collectionGuid) {
            this.fields = await this.getFields(template.collectionGuid);
            this.renderMappings(template.mappings);
        } else {
            this.fields = [];
            this.renderMappings();
        }

        this.showView('template-editor');
    }

    getOptions(field) {
        const opts = [{ v: '', l: "Don't map" }];
        if (field.type === 'text') opts.push({ v: 'page-title', l: 'Page Title' }, { v: 'page-description', l: 'Description' }, { v: 'custom', l: 'Custom' }, { v: 'static', l: 'Static' });
        else if (field.type === 'url') opts.push({ v: 'page-url', l: 'Page URL' }, { v: 'custom', l: 'Custom' });
        else if (field.type === 'banner') opts.push({ v: 'page-image', l: 'Page Image' });
        else if (field.type === 'choice') { opts.push({ v: 'custom', l: 'Select at Save' }); field.choices?.forEach(c => opts.push({ v: `choice:${c.id}`, l: c.label })); }
        else if (field.type === 'checkbox') opts.push({ v: 'static:true', l: 'True' }, { v: 'static:false', l: 'False' });
        else opts.push({ v: 'custom', l: 'Custom' }, { v: 'static', l: 'Static' });
        return opts;
    }

    renderMappings(existing = []) {
        const el = this.$('mappings-list');
        if (!this.fields.length) { el.innerHTML = '<p style="color:#666;font-size:11px">Select a collection</p>'; return; }
        const typeLabels = { text: 'Text', url: 'URL', banner: 'Image', choice: 'Choice', checkbox: 'Check', number: 'Number' };

        el.innerHTML = this.fields.filter(f => !['created_at', 'updated_at'].includes(f.id)).map(f => {
            const e = existing.find(m => m.fieldId === f.id);
            let val = e?.source || '';
            if (e?.source === 'static' && f.type === 'choice') val = `choice:${e.staticValue}`;
            else if (e?.source === 'static' && f.type === 'checkbox') val = `static:${e.staticValue}`;

            const opts = this.getOptions(f).map(o => `<option value="${o.v}" ${val === o.v ? 'selected' : ''}>${o.l}</option>`).join('');
            const extra = e?.source === 'static' && !['choice', 'checkbox'].includes(f.type) ? `<input class="mapping-static-value" data-field-id="${f.id}" value="${e.staticValue || ''}" placeholder="Value">` : '';
            return `<div class="mapping-row"><div class="mapping-field-info"><span class="mapping-field-name">${f.label}</span><span class="mapping-field-type">${typeLabels[f.type] || f.type}</span></div><span class="mapping-arrow">→</span><div class="mapping-config"><select class="mapping-source" data-field-id="${f.id}" data-field-type="${f.type}" data-field-label="${f.label}">${opts}</select>${extra}</div></div>`;
        }).join('');

        el.querySelectorAll('.mapping-source').forEach(s => s.onchange = () => this.renderMappings(this.collectMappings()));
    }

    collectMappings() {
        const mappings = [];
        document.querySelectorAll('#mappings-list .mapping-source').forEach(sel => {
            const src = sel.value;
            if (!src) return;
            const m = { fieldId: sel.dataset.fieldId, fieldType: sel.dataset.fieldType, fieldLabel: sel.dataset.fieldLabel };
            if (src.startsWith('choice:')) { m.source = 'static'; m.staticValue = src.slice(7); }
            else if (src.startsWith('static:')) { m.source = 'static'; m.staticValue = src.slice(7); }
            else if (src === 'static') { m.source = 'static'; m.staticValue = document.querySelector(`.mapping-static-value[data-field-id="${m.fieldId}"]`)?.value || ''; }
            else m.source = src;
            const f = this.fields.find(x => x.id === m.fieldId);
            if (f?.type === 'choice' && f.choices) m.choices = f.choices;
            mappings.push(m);
        });
        return mappings;
    }

    async saveTemplate() {
        const name = this.$('editor-template-name').value.trim();
        const guid = this.$('editor-collection').value;
        if (!name || !guid) return alert('Fill all fields');

        const col = this.collections.find(c => c.guid === guid);
        const bodySource = this.$('editor-body-source').value;
        const clipContent = bodySource === 'page-content';
        const data = { id: this.currentTemplate?.id || Date.now().toString(), name, collectionGuid: guid, collectionName: col?.name, mappings: this.collectMappings(), clipContent };
        const idx = this.templates.findIndex(t => t.id === this.currentTemplate?.id);
        idx >= 0 ? this.templates[idx] = data : this.templates.push(data);

        await this.saveTemplates();
        this.renderTemplates();
        this.showView('template-selector');
    }

    async deleteTemplate() {
        if (!this.currentTemplate) return;
        this.templates = this.templates.filter(t => t.id !== this.currentTemplate.id);
        this.currentTemplate = null;
        await this.saveTemplates();
        this.renderTemplates();
        this.showView('template-selector');
    }

    async save() {
        if (!this.connected || !this.currentTemplate) return;
        const btn = this.$('save-btn');
        btn.disabled = true;

        try {
            const props = {};
            const title = this.$('preview-title').value;
            const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];
            const safeSet = (obj, key, value) => {
                if (!DANGEROUS_KEYS.includes(key)) obj[key] = value;
            };

            this.currentTemplate.mappings.forEach(m => {
                if (m.source === 'page-title') safeSet(props, m.fieldId, title);
                else if (m.source === 'page-url') safeSet(props, m.fieldId, this.pageData?.url);
                else if (m.source === 'page-description') safeSet(props, m.fieldId, this.pageData?.description);
                else if (m.source === 'static') safeSet(props, m.fieldId, m.staticValue);
                else if (m.source === 'custom') safeSet(props, m.fieldId, document.querySelector(`[data-field-id="${m.fieldId}"]`)?.value || '');
            });

            const hasBanner = this.currentTemplate.mappings?.some(m => m.source === 'page-image');

            const res = await this.send({
                type: SaveToThymer.MSG.THYMER_SAVE_RECORD,
                payload: {
                    collectionGuid: this.currentTemplate.collectionGuid,
                    title,
                    properties: props,
                    bannerUrl: hasBanner ? this.selectedBanner : null,
                    bodyMarkdown: this.currentTemplate.clipContent ? this.pageData?.bodyMarkdown || '' : null
                }
            });

            if (res?.success) {
                try {
                    if (this.sourceWindowId) await chrome.windows.update(this.sourceWindowId, { focused: true });
                    if (this.sourceTabId) await chrome.tabs.update(this.sourceTabId, { active: true });
                } catch { }
                setTimeout(() => window.close(), 100);
            } else throw new Error(res?.error || 'Failed');
        } catch {
            btn.disabled = false;
        }
    }



    exportTemplates() {
        const blob = new Blob([JSON.stringify(this.templates, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'thymer-templates.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    async importTemplates(e) {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const imported = JSON.parse(await file.text());
            if (!Array.isArray(imported)) throw new Error();
            this.templates = imported;
            await this.saveTemplates();
            this.renderTemplates();
            this.showView('template-selector');
        } catch {
            alert('Invalid file format');
        }
        e.target.value = '';
    }
}

document.addEventListener('DOMContentLoaded', () => new SaveToThymer());
class Toast {
    static show(message, type, duration) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('visible'));
        setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    static success(message, duration = 2000) {
        this.show(message, 'success', duration);
    }

    static error(message, duration = 3000) {
        this.show(message, 'error', duration);
    }

}

const { getDefaultEnglishSettings, getDefaultChineseSettings } =
    window.SubtitleConfig;

class PopupController {
    constructor() {
        this.currentLanguage = 'english';
        this.apiConfig = window.SubtitleConfig.normalizeApiConfig(
            window.SubtitleConfig.DEFAULT_API_CONFIG
        );
        this.newApiProviderDraft = null;
        this.isTranslating = false;
        this.englishSettings = getDefaultEnglishSettings();
        this.chineseSettings = getDefaultChineseSettings();
        this.themeMode = 'system';
        this.themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        this.handleSystemThemeChange = () => {
            if (this.themeMode === 'system') {
                this.applyTheme();
            }
        };

        if (typeof this.themeMediaQuery.addEventListener === 'function') {
            this.themeMediaQuery.addEventListener('change', this.handleSystemThemeChange);
        } else if (typeof this.themeMediaQuery.addListener === 'function') {
            this.themeMediaQuery.addListener(this.handleSystemThemeChange);
        }

        this.applyTheme();

        this.init();
    }

    // 辅助方法：健壮地设置下拉框选中项，确保UI显示同步
    setSelectValue(selectEl, value) {
        if (!selectEl) return;
        const options = Array.from(selectEl.options || []);
        let index = options.findIndex(opt => opt.value === value);
        if (index >= 0) {
            selectEl.selectedIndex = index;
            options.forEach((opt, i) => opt.selected = i === index);
        }
    }

    createDefaultApiProvider(overrides = {}) {
        return {
            id: overrides.id || `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: overrides.name ?? '',
            providerType: overrides.providerType,
            openaiBaseUrl: overrides.openaiBaseUrl ?? '',
            openaiApiKey: overrides.openaiApiKey ?? '',
            llmModel: overrides.llmModel ?? '',
            threadNum: overrides.threadNum ??
                window.SubtitleConfig.DEFAULT_API_CONFIG.threadNum,
            disableThinking: true
        };
    }

    getActiveApiProvider() {
        this.apiConfig = window.SubtitleConfig.normalizeApiConfig(this.apiConfig);
        return this.apiConfig.providers.find(provider => provider.id === this.apiConfig.activeProviderId)
            || null;
    }

    getEditingApiProvider() {
        return this.newApiProviderDraft || this.getActiveApiProvider();
    }

    isDefaultApiProvider(providerOrId) {
        const providerId = typeof providerOrId === 'string'
            ? providerOrId
            : providerOrId?.id;
        return window.SubtitleConfig.isDefaultApiProviderId(providerId || '');
    }

    getApiBaseUrlInputValue(provider) {
        const baseUrl = provider?.openaiBaseUrl || '';
        if (this.isDefaultApiProvider(provider) && provider.providerType === 'openai') {
            return baseUrl.replace(/\/v1\/?$/i, '');
        }
        return baseUrl;
    }

    getModelConcurrencyLimit(model) {
        return window.SubtitleConfig.getModelConcurrencyLimit(model);
    }

    normalizeThreadNum(value, model) {
        const max = this.getModelConcurrencyLimit(model);
        return window.SubtitleConfig.normalizeConcurrency(value, max);
    }

    updateConcurrencyInputLimit(model) {
        const threadNum = document.getElementById('threadNum');
        if (!threadNum) return;

        const max = this.getModelConcurrencyLimit(model);
        const normalized = this.normalizeThreadNum(threadNum.value, model);
        if (max === undefined) {
            threadNum.removeAttribute('max');
        } else {
            threadNum.max = String(max);
        }
        threadNum.value = String(normalized);
    }

    syncActiveProviderFields() {
        const provider = this.getActiveApiProvider();
        if (!provider) {
            this.apiConfig.openaiBaseUrl = '';
            this.apiConfig.openaiApiKey = '';
            this.apiConfig.llmModel = '';
            return;
        }
        this.apiConfig.openaiBaseUrl = provider.openaiBaseUrl;
        this.apiConfig.openaiApiKey = provider.openaiApiKey;
        this.apiConfig.llmModel = provider.llmModel;
        this.apiConfig.threadNum = provider.threadNum ||
            window.SubtitleConfig.DEFAULT_API_CONFIG.threadNum;
        this.apiConfig.disableThinking = true;
    }

    collectActiveProviderFromUI() {
        const provider = this.getEditingApiProvider();
        const providerName = document.getElementById('apiProviderName');
        const apiBaseUrl = document.getElementById('apiBaseUrl');
        const apiKey = document.getElementById('apiKey');
        const llmModel = document.getElementById('llmModel');
        const targetLanguage = document.getElementById('targetLanguage');
        const threadNum = document.getElementById('threadNum');

        if (!provider) return null;
        if (apiKey) provider.openaiApiKey = apiKey.value.trim();
        if (llmModel) provider.llmModel = llmModel.value.trim();
        if (!this.isDefaultApiProvider(provider)) {
            if (providerName) provider.name = providerName.value.trim() || '未命名供应商';
            if (apiBaseUrl) provider.openaiBaseUrl = apiBaseUrl.value.trim();
        }
        if (targetLanguage) this.apiConfig.targetLanguage = targetLanguage.value;
        if (threadNum) {
            provider.threadNum = this.normalizeThreadNum(threadNum.value, provider.llmModel);
            threadNum.value = String(provider.threadNum);
        }
        if (!this.newApiProviderDraft) {
            this.syncActiveProviderFields();
        }
        return provider;
    }

    setApiProviderFieldMutability(provider) {
        const isDefaultProvider = this.isDefaultApiProvider(provider);
        const lockedFieldIds = ['apiProviderName', 'apiBaseUrl'];
        lockedFieldIds.forEach(id => {
            const field = document.getElementById(id);
            if (field) field.disabled = Boolean(provider && isDefaultProvider);
        });
        ['apiBaseUrl'].forEach(id => {
            const field = document.getElementById(id);
            if (field) field.required = Boolean(provider && !isDefaultProvider);
        });
        const llmModel = document.getElementById('llmModel');
        if (llmModel) {
            llmModel.disabled = false;
            llmModel.required = Boolean(provider);
        }
    }

    escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    async init() {
        await this.loadThemePreference();

        this.setupTabs();
        this.bindEvents();

        // 先确保默认设置写入 storage，再加载当前状态
        try {
            await this.ensureDefaultSettings();
        } catch {}

        await this.loadCurrentState();

        // 初始化API设置
        await this.loadApiConfig();
        this.initApiSettingsUI();

        this.getCurrentVideoInfo();
        this.checkTranslationProgress();
        this.startProgressListener();
        await this.updateTranslateButton();
    }

    getEffectiveTheme() {
        if (this.themeMode === 'light' || this.themeMode === 'dark') {
            return this.themeMode;
        }

        return this.themeMediaQuery.matches ? 'dark' : 'light';
    }

    applyTheme() {
        const root = document.documentElement;
        const effectiveTheme = this.getEffectiveTheme();
        root.dataset.themeMode = this.themeMode;
        root.dataset.themeEffective = effectiveTheme;
    }

    async loadThemePreference() {
        try {
            const result = await chrome.storage.local.get(['popupThemeMode']);
            const storedTheme = result.popupThemeMode;

            if (storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system') {
                this.themeMode = storedTheme;
            } else {
                this.themeMode = 'system';
            }
        } catch {
            this.themeMode = 'system';
        }

        this.applyTheme();

        const themeMode = document.getElementById('themeMode');
        if (themeMode) {
            this.setSelectValue(themeMode, this.themeMode);
        }
    }

    async updateThemeMode(mode) {
        this.themeMode = mode;
        this.applyTheme();

        try {
            await chrome.storage.local.set({ popupThemeMode: mode });
        } catch {
            Toast.error('主题设置保存失败');
        }
    }

    async ensureDefaultSettings() {
        try {
            const result = await chrome.storage.local.get(['englishSettings', 'chineseSettings']);
            const updates = [
                ['english', this.englishSettings, result.englishSettings],
                ['chinese', this.chineseSettings, result.chineseSettings]
            ].filter(([, , stored]) => !stored || Object.keys(stored).length === 0);
            await Promise.all(updates.map(([language, data]) =>
                chrome.runtime.sendMessage({
                    action: 'updateSettings',
                    settings: { language, data }
                })
            ));
        } catch {}
    }

    // ========================================
    // 标签页管理
    // ========================================
    setupTabs() {
        const tabButtons = document.querySelectorAll('.tab-button');

        tabButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const tabId = e.currentTarget.dataset.tab;
                this.switchTab(tabId);
            });
        });
    }

    switchTab(tabId) {
        // 更新按钮状态
        document.querySelectorAll('.tab-button').forEach(btn => {
            btn.classList.remove('active');
        });
        const activeBtn = document.querySelector(`[data-tab="${tabId}"]`);
        if (activeBtn) activeBtn.classList.add('active');

        // 更新内容显示
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });

        const targetContent = document.getElementById(`${tabId}Tab`);
        if (targetContent) {
            targetContent.classList.add('active');
        }
    }

    // ========================================
    // 事件绑定
    // ========================================
    bindEvents() {
        // 字幕主开关
        const subtitleToggle = document.getElementById('subtitleToggle');
        if (subtitleToggle) {
            subtitleToggle.addEventListener('change', (e) => {
                this.toggleSubtitle(e.target.checked);
            });
        }

        // 设置控件事件
        this.bindSettingsEvents();

        // 翻译按钮和API设置事件
        this.bindTranslateEvents();
        this.bindApiSettingsEvents();
    }

    bindSettingsEvents() {
        // 语言切换按钮
        const englishTab = document.getElementById('englishTab');
        const chineseTab = document.getElementById('chineseTab');

        if (englishTab && chineseTab) {
            englishTab.addEventListener('click', () => this.switchLanguage('english'));
            chineseTab.addEventListener('click', () => this.switchLanguage('chinese'));
        }

        const themeMode = document.getElementById('themeMode');
        if (themeMode) {
            this.setSelectValue(themeMode, this.themeMode);
            themeMode.addEventListener('change', (e) => {
                this.updateThemeMode(e.target.value);
            });
        }

        // 设置控件
        this.bindSettingControls();

        // 重置按钮
        const resetBtn = document.getElementById('resetSettings');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => this.resetToDefault());
        }
    }

    bindSettingControls() {
        // 字体大小
        const fontSize = document.getElementById('fontSize');
        const fontSizeValue = document.getElementById('fontSizeValue');
        if (fontSize && fontSizeValue) {
            fontSize.addEventListener('input', (e) => {
                const value = parseInt(e.target.value);
                fontSizeValue.textContent = value + 'px';
                this.updateCurrentLanguageSetting('fontSize', value);
            });
        }

        // 字体颜色
        const fontColorPreset = document.getElementById('fontColorPreset');
        const fontColor = document.getElementById('fontColor');
        const colorPreview = document.getElementById('colorPreview');

        if (fontColorPreset) {
            fontColorPreset.addEventListener('change', (e) => {
                const value = e.target.value;
                if (value === 'custom') {
                    fontColor.style.display = 'block';
                    fontColor.click();
                } else {
                    fontColor.style.display = 'none';
                    this.updateCurrentLanguageSetting('fontColor', value);
                    if (colorPreview) {
                        colorPreview.style.backgroundColor = value;
                    }
                }
            });
        }

        if (fontColor) {
            fontColor.addEventListener('change', (e) => {
                const value = e.target.value;
                this.updateCurrentLanguageSetting('fontColor', value);
                if (colorPreview) {
                    colorPreview.style.backgroundColor = value;
                }
            });
        }

        // 高级设置控件
        this.bindAdvancedControls();
    }

    bindAdvancedControls() {
        // 字体类型
        const fontFamily = document.getElementById('fontFamily');
        if (fontFamily) {
            // 去掉"系统默认"，优先提供 Noto Serif
            const fontOptions = [
                { value: '"Noto Serif", Georgia, serif', text: 'Noto Serif' },
                { value: 'Arial, sans-serif', text: 'Arial' },
                { value: 'Georgia, serif', text: 'Georgia' },
                { value: '"Times New Roman", serif', text: 'Times New Roman' },
                { value: '"Courier New", monospace', text: 'Courier New' },
                { value: '"Helvetica Neue", sans-serif', text: 'Helvetica Neue' },
                { value: '"Songti SC", serif', text: '宋体' },
                { value: '"Microsoft YaHei", sans-serif', text: '微软雅黑' },
                { value: '"PingFang SC", sans-serif', text: '苹方' }
            ];

            fontFamily.innerHTML = fontOptions.map(option =>
                `<option value='${option.value}'>${option.text}</option>`
            ).join('');

            // 初始化时使用当前设置的字体值
            const currentSettings = this.currentLanguage === 'english' ? this.englishSettings : this.chineseSettings;
            const currentFontFamily = currentSettings.fontFamily || (this.currentLanguage === 'english'
                ? '"Noto Serif", Georgia, serif'
                : '"Songti SC", serif');

            this.setSelectValue(fontFamily, currentFontFamily);

            fontFamily.addEventListener('change', (e) => {
                this.updateCurrentLanguageSetting('fontFamily', e.target.value);
            });
        }

        // 字体粗细
        const fontWeight = document.getElementById('fontWeight');
        if (fontWeight) {
            fontWeight.addEventListener('change', (e) => {
                this.updateCurrentLanguageSetting('fontWeight', e.target.value);
            });
        }
    }

    // ========================================
    // 语言切换
    // ========================================
    switchLanguage(language) {
        this.currentLanguage = language;

        // 更新按钮状态
        document.querySelectorAll('.lang-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        const langTab = document.getElementById(language + 'Tab');
        if (langTab) langTab.classList.add('active');

        // 切换预设显示
        const englishPresets = document.getElementById('englishPresets');
        const chinesePresets = document.getElementById('chinesePresets');

        if (englishPresets && chinesePresets) {
            if (language === 'english') {
                englishPresets.style.display = 'grid';
                chinesePresets.style.display = 'none';
            } else {
                englishPresets.style.display = 'none';
                chinesePresets.style.display = 'grid';
            }
        }

        // 加载当前语言设置到UI
        this.loadLanguageSettingsToUI(language);
    }

    // ========================================
    // 设置管理
    // ========================================
    updateCurrentLanguageSetting(key, value) {
        const settings = this.currentLanguage === 'english' ? this.englishSettings : this.chineseSettings;
        settings[key] = value;

        // 保存设置
        this.updateSettings({
            language: this.currentLanguage,
            data: { [key]: value }
        });

        // 显示保存状态
        // Toast.success('设置已保存'); // 已保存反馈改为静默，UI变化已足够反馈
    }

    loadLanguageSettingsToUI(language) {
        const settings = language === 'english' ? this.englishSettings : this.chineseSettings;

        // 字体大小
        if (settings.fontSize !== undefined) {
            const fontSize = document.getElementById('fontSize');
            const fontSizeValue = document.getElementById('fontSizeValue');
            if (fontSize) fontSize.value = settings.fontSize;
            if (fontSizeValue) fontSizeValue.textContent = settings.fontSize + 'px';
        }

        // 字体颜色
        if (settings.fontColor) {
            const fontColorPreset = document.getElementById('fontColorPreset');
            const fontColor = document.getElementById('fontColor');
            const colorPreview = document.getElementById('colorPreview');

            // 检查是否为预设颜色
            const isPresetColor = Array.from(fontColorPreset?.options || []).some(option => option.value === settings.fontColor);

            if (fontColorPreset) {
                if (isPresetColor) {
                    fontColorPreset.value = settings.fontColor;
                    if (fontColor) fontColor.style.display = 'none';
                } else {
                    fontColorPreset.value = 'custom';
                    if (fontColor) {
                        fontColor.style.display = 'block';
                        fontColor.value = settings.fontColor;
                    }
                }
            }

            if (colorPreview) {
                colorPreview.style.backgroundColor = settings.fontColor;
            }
        }

        // 高级设置 - 字体类型
        const fontFamily = document.getElementById('fontFamily');
        if (fontFamily) {
            // 如果存储的 fontFamily 为空，使用默认值
            const fontFamilyValue = settings.fontFamily || (language === 'english'
                ? '"Noto Serif", Georgia, serif'
                : '"Songti SC", serif');

            this.setSelectValue(fontFamily, fontFamilyValue);
        }

        if (settings.fontWeight) {
            const fontWeight = document.getElementById('fontWeight');
            if (fontWeight) fontWeight.value = settings.fontWeight;
        }
    }

    // ========================================
    // 获取当前视频ID的辅助方法
    // ========================================
    async getCurrentVideoId() {
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const currentTab = tabs[0];
            if (!currentTab) return null;

            return await new Promise((resolve) => {
                chrome.tabs.sendMessage(currentTab.id, { action: 'getVideoInfo' }, (response) => {
                    if (chrome.runtime.lastError || !response || !response.videoId) {
                        resolve(null);
                    } else {
                        resolve(response.videoId);
                    }
                });
            });
        } catch {
            return null;
        }
    }

    async getTranslationStatus(videoId) {
        const currentVideoId = videoId === undefined
            ? await this.getCurrentVideoId()
            : videoId;
        const response = await chrome.runtime.sendMessage({
            action: 'getTranslationStatus',
            videoId: currentVideoId
        });
        if (!response?.success) {
            throw new Error(response?.error || '读取翻译状态失败');
        }
        return response.status || {
            isTranslating: false,
            progress: null,
            cachedResult: null
        };
    }

    // ========================================
    // 文件处理
    // ========================================
    async loadCurrentState() {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'getBilingualSubtitleData' });
            if (response.success) {
                const {
                    subtitleEnabled,
                    englishSettings,
                    chineseSettings
                } = response.data;

                const subtitleToggle = document.getElementById('subtitleToggle');
                if (subtitleToggle) subtitleToggle.checked = subtitleEnabled;

                const defaultEnglishSettings = getDefaultEnglishSettings();
                const defaultChineseSettings = getDefaultChineseSettings();
                const isEmpty = (obj) => !obj || window.SubtitleConfig.isEmptySettings(obj);
                this.englishSettings = isEmpty(englishSettings) ? defaultEnglishSettings : englishSettings;
                this.chineseSettings = isEmpty(chineseSettings) ? defaultChineseSettings : chineseSettings;

                let needPersistFix = false;
                if (!this.englishSettings.fontFamily || this.englishSettings.fontFamily === 'inherit') {
                    this.englishSettings.fontFamily = defaultEnglishSettings.fontFamily;
                    needPersistFix = true;
                }
                if (!this.chineseSettings.fontWeight) {
                    this.chineseSettings.fontWeight = defaultChineseSettings.fontWeight;
                    needPersistFix = true;
                }

                if (needPersistFix) {
                    try {
                        await this.updateSettings({ language: 'english', data: { fontFamily: this.englishSettings.fontFamily } });
                        await this.updateSettings({
                            language: 'chinese', data: {
                                fontWeight: this.chineseSettings.fontWeight,
                                fontFamily: this.chineseSettings.fontFamily
                            }
                        });
                    } catch {}
                }
                this.loadLanguageSettingsToUI(this.currentLanguage);
            }
        } catch {
            Toast.error('加载设置失败');
        }
    }

    async toggleSubtitle(enabled) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'toggleSubtitle',
                enabled: enabled
            });

            if (response.success) {
                Toast.success(enabled ? '字幕显示已开启' : '字幕显示已关闭');
            } else {
                throw new Error(response.error);
            }
        } catch (error) {
            Toast.error('操作失败: ' + error.message);

            // 恢复开关状态
            const subtitleToggle = document.getElementById('subtitleToggle');
            if (subtitleToggle) subtitleToggle.checked = !enabled;
        }
    }

    async updateSettings(settings) {
        try {
            await chrome.runtime.sendMessage({
                action: 'updateSettings',
                settings: settings
            });

            // 显示保存状态提示
            // Toast.success('设置已保存'); // 已保存反馈改为静默，UI变化已足够反馈
        } catch {}
    }

    resetToDefault() {
        // 获取默认设置（从统一配置中心）
        const defaultEnglishSettings = getDefaultEnglishSettings();
        const defaultChineseSettings = getDefaultChineseSettings();

        // 更新设置对象
        this.englishSettings = { ...defaultEnglishSettings };
        this.chineseSettings = { ...defaultChineseSettings };

        // 加载当前语言设置到UI
        this.loadLanguageSettingsToUI(this.currentLanguage);

        // 保存设置
        this.updateSettings({ language: 'english', data: defaultEnglishSettings });
        this.updateSettings({ language: 'chinese', data: defaultChineseSettings });

        // 显示状态
        // Toast.success('设置已保存'); // 已保存反馈改为静默，UI变化已足够反馈
        Toast.success('已恢复默认设置');
    }

    async getCurrentVideoInfo() {
        try {
            // 获取当前活动的YouTube标签页
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs.length === 0) return;

            const currentTab = tabs[0];
            // 向content script发送消息获取视频信息（不依赖读取tab.url权限）
            chrome.tabs.sendMessage(currentTab.id, { action: 'getVideoInfo' }, (response) => {
                if (chrome.runtime.lastError || !response || !response.videoId) {
                    this.updateVideoDisplay(null, '未在YouTube页面');
                    return;
                }
                this.updateVideoDisplay(response.videoId, response.subtitleLoaded ? '已加载字幕' : '无字幕');
            });
        } catch {
            this.updateVideoDisplay(null, '获取失败');
        }
    }

    updateVideoDisplay(videoId, status) {
        const videoIdElement = document.getElementById('currentVideoId');
        const statusElement = document.getElementById('autoLoadStatus');

        if (videoIdElement) {
            videoIdElement.textContent = videoId ? '已识别当前视频' : '未检测到视频';
            videoIdElement.title = videoId || '';
        }

        if (statusElement) {
            statusElement.textContent = status || '等待检测';

            // 更新状态样式
            statusElement.className = 'load-status';
            if (status === '已加载字幕') {
                statusElement.classList.add('success');
            } else if (status && (status.includes('失败') || status.includes('错误'))) {
                statusElement.classList.add('error');
            } else if (status && (status.includes('加载中') || status.includes('检测中'))) {
                statusElement.classList.add('loading');
            }
        }
    }

    // ========================================
    // API配置管理（独立版本专用）
    // ========================================

    async loadApiConfig() {
        try {
            const result = await chrome.storage.local.get(['apiConfig']);
            const migration = window.SubtitleConfig.migrateApiConfig(result.apiConfig || {});
            this.apiConfig = migration.config;

            if (migration.changed) {
                await chrome.storage.local.set({ apiConfig: this.apiConfig });
            }
        } catch {}
    }

    async persistApiConfig() {
        const migration = window.SubtitleConfig.migrateApiConfig(this.apiConfig);
        this.apiConfig = migration.config;
        await chrome.storage.local.set({ apiConfig: this.apiConfig });
    }

    async saveApiConfig() {
        try {
            this.syncActiveProviderFields();
            await this.persistApiConfig();
            Toast.success('API配置已保存');
        } catch (error) {
            Toast.error('保存失败: ' + error.message);
        }
    }

    initApiSettingsUI() {
        // 填充目标语言下拉框
        const targetLangSelect = document.getElementById('targetLanguage');
        if (targetLangSelect && window.SubtitleConfig?.SUPPORTED_LANGUAGES) {
            targetLangSelect.innerHTML = window.SubtitleConfig.SUPPORTED_LANGUAGES.map(l =>
                `<option value="${l.value}">${l.text}</option>`
            ).join('');
        }

        // 加载保存的配置到UI
        this.loadApiConfigToUI();
    }

    loadApiConfigToUI() {
        this.apiConfig = window.SubtitleConfig.normalizeApiConfig(this.apiConfig);
        const activeProvider = this.getEditingApiProvider();
        const providerSelect = document.getElementById('apiProviderSelect');
        const providerName = document.getElementById('apiProviderName');
        const apiBaseUrl = document.getElementById('apiBaseUrl');
        const apiKey = document.getElementById('apiKey');
        const llmModel = document.getElementById('llmModel');
        const targetLanguage = document.getElementById('targetLanguage');
        const threadNum = document.getElementById('threadNum');

        if (providerSelect) {
            const providers = this.newApiProviderDraft
                ? [...this.apiConfig.providers, this.newApiProviderDraft]
                : this.apiConfig.providers;
            providerSelect.innerHTML = [
                '<option value="" disabled hidden>请选择模型</option>',
                ...providers.map(provider =>
                `<option value="${this.escapeHtml(provider.id)}">${this.escapeHtml(provider.name || '未命名供应商')}</option>`
                )
            ].join('');
            this.setSelectValue(
                providerSelect,
                this.newApiProviderDraft?.id || this.apiConfig.activeProviderId
            );
        }
        if (providerName) providerName.value = activeProvider?.name || '';
        if (apiBaseUrl) apiBaseUrl.value = this.getApiBaseUrlInputValue(activeProvider);
        if (apiKey) apiKey.value = activeProvider?.openaiApiKey || '';
        if (llmModel) llmModel.value = activeProvider?.llmModel || '';
        if (targetLanguage) this.setSelectValue(targetLanguage, this.apiConfig.targetLanguage);
        if (threadNum) {
            threadNum.value = activeProvider?.threadNum ||
                window.SubtitleConfig.DEFAULT_API_CONFIG.threadNum;
        }
        this.updateConcurrencyInputLimit(activeProvider?.llmModel || '');
        this.setApiProviderFieldMutability(activeProvider);

        const deleteProviderBtn = document.getElementById('deleteProviderBtn');
        if (deleteProviderBtn) {
            const isDefaultProvider = this.isDefaultApiProvider(activeProvider);
            deleteProviderBtn.disabled = !activeProvider || Boolean(this.newApiProviderDraft) || isDefaultProvider;
            deleteProviderBtn.title = '删除供应商';
        }

        // 检查API状态
        if (this.newApiProviderDraft) {
            const apiStatus = document.getElementById('apiStatus');
            if (apiStatus) apiStatus.style.display = 'none';
        }
    }

    bindApiSettingsEvents() {
        const providerSelect = document.getElementById('apiProviderSelect');
        if (providerSelect) {
            providerSelect.addEventListener('change', (e) => {
                if (this.newApiProviderDraft) {
                    if (e.target.value === this.newApiProviderDraft.id) return;
                    this.newApiProviderDraft = null;
                } else {
                    this.collectActiveProviderFromUI();
                }
                this.apiConfig.activeProviderId = e.target.value;
                this.apiConfig.requiresProviderSelection = !e.target.value;
                this.syncActiveProviderFields();
                this.loadApiConfigToUI();
            });
        }

        const addProviderBtn = document.getElementById('addProviderBtn');
        if (addProviderBtn) {
            addProviderBtn.addEventListener('click', () => this.addApiProvider());
        }

        const deleteProviderBtn = document.getElementById('deleteProviderBtn');
        if (deleteProviderBtn) {
            deleteProviderBtn.addEventListener('click', () => this.deleteActiveApiProvider());
        }

        const providerName = document.getElementById('apiProviderName');
        if (providerName) {
            providerName.addEventListener('input', (e) => {
                const provider = this.getEditingApiProvider();
                if (!provider || this.isDefaultApiProvider(provider)) return;
                provider.name = e.target.value.trim() || '未命名供应商';
                this.loadApiProviderOptions();
            });
        }

        // API Base URL
        const apiBaseUrl = document.getElementById('apiBaseUrl');
        if (apiBaseUrl) {
            const updateBaseUrl = (e) => {
                const provider = this.getEditingApiProvider();
                if (!provider || this.isDefaultApiProvider(provider)) return;
                provider.openaiBaseUrl = e.target.value.trim();
                if (!this.newApiProviderDraft) this.syncActiveProviderFields();
            };
            apiBaseUrl.addEventListener('input', updateBaseUrl);
            apiBaseUrl.addEventListener('change', updateBaseUrl);
        }

        // API Key
        const apiKey = document.getElementById('apiKey');
        if (apiKey) {
            apiKey.addEventListener('change', (e) => {
                const provider = this.getEditingApiProvider();
                if (!provider) return;
                provider.openaiApiKey = e.target.value.trim();
                if (!this.newApiProviderDraft) this.syncActiveProviderFields();
            });
        }

        // API Key 可见性切换
        const toggleVisibility = document.getElementById('toggleApiKeyVisibility');
        if (toggleVisibility && apiKey) {
            toggleVisibility.addEventListener('click', () => {
                apiKey.type = apiKey.type === 'password' ? 'text' : 'password';
            });
        }

        // LLM模型输入
        const llmModel = document.getElementById('llmModel');
        if (llmModel) {
            llmModel.addEventListener('input', (e) => {
                const provider = this.getEditingApiProvider();
                if (!provider) return;
                provider.llmModel = e.target.value.trim();
                this.updateConcurrencyInputLimit(provider.llmModel);
                provider.threadNum = this.normalizeThreadNum(
                    document.getElementById('threadNum')?.value,
                    provider.llmModel
                );
                if (!this.newApiProviderDraft) this.syncActiveProviderFields();
            });
        }

        // 主翻译区的目标语言
        const targetLanguage = document.getElementById('targetLanguage');
        if (targetLanguage) {
            targetLanguage.addEventListener('change', async (e) => {
                this.apiConfig.targetLanguage = e.target.value;
                try {
                    await this.persistApiConfig();
                } catch {}
            });
        }

        // 并发数
        const threadNum = document.getElementById('threadNum');
        if (threadNum) {
            threadNum.addEventListener('input', (e) => {
                const provider = this.getEditingApiProvider();
                if (!provider) return;
                const value = this.normalizeThreadNum(e.target.value, provider.llmModel);
                provider.threadNum = value;
                e.target.value = String(value);
                if (!this.newApiProviderDraft) this.syncActiveProviderFields();
            });
        }

        // 测试连接按钮
        const testApiBtn = document.getElementById('testApiBtn');
        if (testApiBtn) {
            testApiBtn.addEventListener('click', () => this.testApiConnection());
        }

        // 保存配置按钮
        const saveApiBtn = document.getElementById('saveApiBtn');
        if (saveApiBtn) {
            saveApiBtn.addEventListener('click', () => this.saveApiConfigFromUI());
        }

    }

    loadApiProviderOptions() {
        const providerSelect = document.getElementById('apiProviderSelect');
        if (!providerSelect) return;

        const providers = this.newApiProviderDraft
            ? [...this.apiConfig.providers, this.newApiProviderDraft]
            : this.apiConfig.providers;
        providerSelect.innerHTML = providers.map(provider =>
            `<option value="${this.escapeHtml(provider.id)}">${this.escapeHtml(provider.name || '未命名供应商')}</option>`
        ).join('');
        this.setSelectValue(
            providerSelect,
            this.newApiProviderDraft?.id || this.apiConfig.activeProviderId
        );
    }

    addApiProvider() {
        this.newApiProviderDraft = this.createDefaultApiProvider();
        this.loadApiConfigToUI();
    }

    deleteActiveApiProvider() {
        const currentId = this.apiConfig.activeProviderId;
        if (this.isDefaultApiProvider(currentId)) {
            return;
        }

        this.apiConfig.providers = this.apiConfig.providers.filter(provider => provider.id !== currentId);
        this.apiConfig.activeProviderId = '';
        this.apiConfig.requiresProviderSelection = true;
        this.syncActiveProviderFields();
        this.loadApiConfigToUI();
    }

    async saveApiConfigFromUI() {
        const provider = this.collectActiveProviderFromUI();

        if (!provider) {
            Toast.error('请先选择模型');
            return;
        }
        if (!provider.llmModel) {
            Toast.error('请填写翻译模型');
            return;
        }
        if (!this.isDefaultApiProvider(provider) && !provider.openaiBaseUrl) {
            Toast.error('自定义模型必须填写 API Base URL 和翻译模型');
            return;
        }

        try {
            await this.requestApiHostPermission(provider);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            Toast.error(`API 权限未授予: ${message}`);
            return;
        }

        if (this.newApiProviderDraft) {
            provider.name = provider.name || '未命名供应商';
            this.apiConfig.providers.push({ ...provider });
            this.apiConfig.activeProviderId = provider.id;
            this.newApiProviderDraft = null;
            this.syncActiveProviderFields();
        }
        this.apiConfig.requiresProviderSelection = false;
        await this.saveApiConfig();
        this.loadApiConfigToUI();
    }

    async testApiConnection() {
        this.showApiStatus('loading', '测试连接中...');
        const provider = this.collectActiveProviderFromUI();

        if (!provider) {
            this.showApiStatus('error', '请先选择模型');
            return;
        }

        try {
            await this.requestApiHostPermission(provider);

            // 测试现有供应商时同步最新配置
            if (!this.newApiProviderDraft) {
                await this.persistApiConfig();
            }

            const headers = {
                'Content-Type': 'application/json'
            };
            if (provider.openaiApiKey) {
                headers.Authorization = `Bearer ${provider.openaiApiKey}`;
            }

            const requestBaseUrl = window.SubtitleConfig.normalizeApiBaseUrl(
                provider.openaiBaseUrl,
                provider.providerType
            );
            const response = await fetch(`${requestBaseUrl}/models`, {
                method: 'GET',
                headers
            });

            if (response.ok) {
                this.showApiStatus('success', 'API连接成功');
            } else {
                const errorMessage = await window.SubtitleConfig.formatApiResponseError(response);
                this.showApiStatus('error', `连接失败: ${errorMessage}`);
            }
        } catch (error) {
            this.showApiStatus('error', `网络错误: ${error.message}`);
        }
    }

    showApiStatus(type, message) {
        const apiStatus = document.getElementById('apiStatus');
        const apiStatusText = document.getElementById('apiStatusText');

        if (apiStatus) {
            apiStatus.style.display = 'flex';
            apiStatus.className = `api-status ${type}`;
        }
        if (apiStatusText) {
            apiStatusText.textContent = message;
        }
    }

    requestApiHostPermission(providerOrBaseUrl) {
        if (
            typeof providerOrBaseUrl === 'object' &&
            this.isDefaultApiProvider(providerOrBaseUrl)
        ) {
            return Promise.resolve();
        }

        const baseUrl = typeof providerOrBaseUrl === 'string'
            ? providerOrBaseUrl
            : providerOrBaseUrl?.openaiBaseUrl;
        const originPattern = window.SubtitleConfig.getApiHostPermissionPattern(baseUrl);

        if (!chrome.permissions || typeof chrome.permissions.request !== 'function') {
            return Promise.reject(new Error('当前扩展不支持动态 API 权限，请重新加载扩展'));
        }

        return new Promise((resolve, reject) => {
            chrome.permissions.request({ origins: [originPattern] }, (granted) => {
                const lastError = chrome.runtime.lastError;
                if (lastError) {
                    reject(new Error(lastError.message));
                    return;
                }

                if (!granted) {
                    reject(new Error(`用户拒绝访问 ${originPattern.replace(/\/\*$/, '')}`));
                    return;
                }

                resolve();
            });
        });
    }

    // ========================================
    // 翻译功能（独立版本专用）
    // ========================================

    /**
     * 检查是否有正在进行的翻译,如果有则恢复进度条显示
     */
    async checkTranslationProgress() {
        try {
            const progress = (await this.getTranslationStatus()).progress;

            if (progress && progress.isTranslating) {
                this.isTranslating = true;
                this.showTranslationProgress(progress);
                this.startProgressListener();
            } else if (progress && progress.error) {
                this.showTranslationError(progress.error);
            } else if (progress && progress.completed) {
                await this.showTranslationCompleted();
            }
        } catch {}
    }

    showTranslationProgress(progress) {
        const translateBtn = document.getElementById('translateBtn');
        const progressRow = document.getElementById('progressRow');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const autoLoadStatus = document.getElementById('autoLoadStatus');

        if (translateBtn) {
            translateBtn.disabled = false; // 允许点击取消
            translateBtn.innerHTML = '<span class="btn-text">取消翻译</span>';
            translateBtn.classList.add('translating');
            // 绑定取消事件(只绑定一次)
            if (!translateBtn._cancelBound) {
                translateBtn._cancelBound = true;
                translateBtn._originalClick = translateBtn.onclick;
                translateBtn.onclick = () => this.forceResetTranslation();
            }
        }
        if (progressRow) progressRow.style.display = 'flex';

        const current = Number.isFinite(progress.current) ? progress.current : 0;
        const total = Number.isFinite(progress.total) && progress.total > 0
            ? progress.total
            : 0;
        const percent = total > 0 ? Math.round((current / total) * 100) : 0;
        if (progressFill) progressFill.style.width = percent + '%';

        const stepNames = {
            'start': '准备翻译...',
            'resume': '恢复翻译中...',
            'split': '断句优化中...',
            'summary': '内容总结中...',
            'translate': '翻译中...',
            'complete': '完成'
        };
        if (progressText) progressText.textContent = `${percent}%`;
        if (autoLoadStatus) autoLoadStatus.textContent = stepNames[progress.step] || '翻译中...';
    }

    showTranslationError(error) {
        const autoLoadStatus = document.getElementById('autoLoadStatus');
        if (autoLoadStatus) {
            autoLoadStatus.textContent = `翻译失败: ${error}`;
            autoLoadStatus.className = 'load-status error';
        }
        this.resetTranslationButton();
        void this.updateTranslateButton();
    }

    async showTranslationCompleted(options = {}) {
        const autoLoadStatus = document.getElementById('autoLoadStatus');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        if (autoLoadStatus) {
            autoLoadStatus.textContent = '翻译完成!';
            autoLoadStatus.className = 'load-status success';
        }
        if (progressFill) progressFill.style.width = '100%';
        if (progressText) progressText.textContent = '100%';

        if (options.enableSubtitle) {
            const subtitleToggle = document.getElementById('subtitleToggle');
            if (subtitleToggle) subtitleToggle.checked = true;
            await this.toggleSubtitle(true);
        }

        this.resetTranslationButton();
        await this.updateTranslateButton();
    }

    startProgressListener() {
        if (this._progressListener) return;

        this._progressListener = async (changes, areaName) => {
            if (areaName !== 'local' || !changes.translationProgress) return;

            const newValue = (await this.getTranslationStatus()).progress;

            if (newValue && newValue.isTranslating) {
                this.showTranslationProgress(newValue);
            } else if (newValue && newValue.error) {
                if (!this._progressListener) return;
                chrome.storage.onChanged.removeListener(this._progressListener);
                this._progressListener = null;
                this.showTranslationError(newValue.error);
            } else if (newValue && newValue.completed) {
                if (!this._progressListener) return;
                chrome.storage.onChanged.removeListener(this._progressListener);
                this._progressListener = null;
                await this.showTranslationCompleted({ enableSubtitle: true });
            }
        };

        chrome.storage.onChanged.addListener(this._progressListener);
    }

    /**
     * 强制重置翻译状态
     */
    async forceResetTranslation() {
        const currentVideoId = await this.getCurrentVideoId();

        // 取消、进度和当前视频缓存由 Translation session 统一清理
        try {
            await chrome.runtime.sendMessage({
                action: 'cancelTranslation',
                videoId: currentVideoId
            });
        } catch {}

        // 停止监听
        if (this._progressListener) {
            chrome.storage.onChanged.removeListener(this._progressListener);
            this._progressListener = null;
        }

        // 重置进度条
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        if (progressFill) progressFill.style.width = '0%';
        if (progressText) progressText.textContent = '0%';

        // 更新状态显示
        const autoLoadStatus = document.getElementById('autoLoadStatus');
        if (autoLoadStatus) {
            autoLoadStatus.textContent = '翻译已取消';
            autoLoadStatus.className = 'load-status';
        }

        // 重置 UI
        this.resetTranslationButton();
        await this.updateTranslateButton();
    }

    /**
     * 重置翻译按钮状态
     */
    resetTranslationButton() {
        this.isTranslating = false;
        const translateBtn = document.getElementById('translateBtn');
        if (translateBtn) {
            translateBtn.disabled = false;
            translateBtn.innerHTML = '<span class="btn-text">开始翻译</span>';
            translateBtn.classList.remove('translating');
            translateBtn._cancelBound = false;
            translateBtn.onclick = null;
        }
    }

    /**
     * 根据缓存状态更新翻译按钮文案
     */
    async updateTranslateButton() {
        const translateBtn = document.getElementById('translateBtn');
        if (!translateBtn || this.isTranslating) return;

        const currentVideoId = await this.getCurrentVideoId();
        if (!currentVideoId) {
            translateBtn.innerHTML = '<span class="btn-text">开始翻译</span>';
            return;
        }

        const cached = (await this.getTranslationStatus(currentVideoId)).cachedResult;

        if (cached && (cached.englishSubtitles?.length > 0 || cached.chineseSubtitles?.length > 0)) {
            translateBtn.innerHTML = '<span class="btn-text">重新翻译</span>';
        } else {
            translateBtn.innerHTML = '<span class="btn-text">开始翻译</span>';
        }
    }

    bindTranslateEvents() {
        const translateBtn = document.getElementById('translateBtn');

        if (translateBtn) {
            translateBtn.addEventListener('click', () => this.startTranslation());
        }
    }

    async startTranslation() {
        if (this.isTranslating) {
            return;
        }

        // 检查API配置
        this.collectActiveProviderFromUI();
        if (!this.apiConfig.openaiBaseUrl) {
            const autoLoadStatus = document.getElementById('autoLoadStatus');
            if (autoLoadStatus) {
                autoLoadStatus.textContent = '请先配置API地址';
                autoLoadStatus.className = 'load-status error';
            }
            this.switchTab('api');
            return;
        }

        try {
            await this.requestApiHostPermission(
                this.getActiveApiProvider() || this.apiConfig.openaiBaseUrl
            );
        } catch (error) {
            const autoLoadStatus = document.getElementById('autoLoadStatus');
            const message = error instanceof Error ? error.message : String(error);
            if (autoLoadStatus) {
                autoLoadStatus.textContent = `API 权限未授予: ${message}`;
                autoLoadStatus.className = 'load-status error';
            }
            return;
        }

        // 获取当前视频ID
        const currentVideoId = await this.getCurrentVideoId();
        const translateBtn = document.getElementById('translateBtn');

        const progressRow = document.getElementById('progressRow');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const autoLoadStatus = document.getElementById('autoLoadStatus');

        try {
            this.isTranslating = true;

            // 立即将按钮变成"取消翻译"状态
            if (translateBtn) {
                translateBtn.disabled = false; // 不禁用按钮，允许点击取消
                translateBtn.innerHTML = '<span class="btn-text">取消翻译</span>';
                translateBtn.classList.add('translating');

                // 绑定取消事件（只绑定一次）
                if (!translateBtn._cancelBound) {
                    translateBtn._cancelBound = true;
                    translateBtn._originalClick = translateBtn.onclick;
                    translateBtn.onclick = () => this.forceResetTranslation();
                }
            }

            if (progressRow) progressRow.style.display = 'flex';
            if (autoLoadStatus) {
                autoLoadStatus.textContent = '获取字幕中...';
                autoLoadStatus.className = 'load-status translating';
            }

            // 1. 从YouTube获取字幕
            const subtitles = await this.fetchYouTubeSubtitles();
            if (!subtitles || subtitles.length === 0) {
                throw new Error('无法获取YouTube字幕，请确保视频有字幕');
            }

            if (autoLoadStatus) autoLoadStatus.textContent = `获取到 ${subtitles.length} 条字幕，准备翻译...`;

            // 获取视频信息（标题、描述等）
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            let videoInfo = {};
            if (tabs.length > 0) {
                try {
                    const response = await new Promise((resolve, reject) => {
                        chrome.tabs.sendMessage(tabs[0].id, { action: 'getVideoInfo' }, (response) => {
                            if (chrome.runtime.lastError) {
                                resolve(null);
                            } else {
                                resolve(response);
                            }
                        });
                    });

                    if (response) {
                        videoInfo = {
                            ytTitle: response.title,
                            description: response.description,
                            aiSummary: response.aiSummary
                        };
                    }
                } catch {}
            }

            // 2. 发送消息到后台启动翻译（popup关闭后仍可继续）
            const response = await chrome.runtime.sendMessage({
                action: 'startTranslation',
                subtitles: subtitles,
                targetLanguage: this.apiConfig.targetLanguage,
                videoId: currentVideoId,
                apiConfig: this.apiConfig,
                videoInfo: videoInfo
            });

            if (!response || !response.success) {
                throw new Error(response?.error || '启动翻译失败');
            }

            // 3. 启动进度监听（监听 storage 变化来更新 UI）
            this.startProgressListener();

            // popup 不再等待翻译完成，用户可以关闭 popup
            if (autoLoadStatus) autoLoadStatus.textContent = '翻译已在后台运行...';
            return; // 翻译结果由 storage 监听器处理
        } catch (error) {
            if (autoLoadStatus) {
                autoLoadStatus.textContent = `翻译失败: ${error.message}`;
                autoLoadStatus.className = 'load-status error';
            }
            this.resetTranslationButton();
            await this.updateTranslateButton();
        }
    }

    async fetchYouTubeSubtitles() {
        return new Promise((resolve, reject) => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (!tabs[0]) {
                    reject(new Error('无法获取当前标签页'));
                    return;
                }

                chrome.tabs.sendMessage(tabs[0].id, { action: 'getYouTubeSubtitles' }, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    if (response && response.success && response.subtitles) {
                        resolve(response.subtitles);
                    } else {
                        reject(new Error(response?.error || '获取字幕失败'));
                    }
                });
            });
        });
    }

}

// 初始化popup控制器
document.addEventListener('DOMContentLoaded', () => {
    // 启动控制器；计数更新由控制器内部统一管理
    new PopupController();
});

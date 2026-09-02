// ========================================
// YouTube字幕助手 - 现代化弹窗控制器
// ========================================

// 轻量级Toast提示系统
class Toast {
    static show(message, type = 'info', duration = 2000) {
        // 创建toast元素
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;

        // 设置样式
        const colors = {
            success: { bg: 'rgba(16, 185, 129, 0.9)', color: '#ffffff' },
            error: { bg: 'rgba(239, 68, 68, 0.9)', color: '#ffffff' },
            warning: { bg: 'rgba(245, 158, 11, 0.9)', color: '#ffffff' },
            info: { bg: 'rgba(59, 130, 246, 0.9)', color: '#ffffff' }
        };

        const style = colors[type] || colors.info;
        toast.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%) translateY(60px);
            padding: 10px 16px;
            background: ${style.bg};
            color: ${style.color};
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            z-index: 9999;
            opacity: 0;
            transition: all 0.3s ease-out;
            max-width: 300px;
            text-align: center;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            backdrop-filter: blur(8px);
        `;

        document.body.appendChild(toast);

        // 动画显示
        setTimeout(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(-50%) translateY(0)';
        }, 10);

        // 自动隐藏
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(-50%) translateY(-60px)';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    static success(message, duration = 2000) {
        this.show(message, 'success', duration);
    }

    static error(message, duration = 3000) {
        this.show(message, 'error', duration);
    }

    static warning(message, duration = 2500) {
        this.show(message, 'warning', duration);
    }

    static info(message, duration = 2000) {
        this.show(message, 'info', duration);
    }
}

class PopupController {
    constructor() {
        this.subtitleData = [];
        this.englishSubtitles = [];
        this.chineseSubtitles = [];
        this.currentFileName = '';
        this.englishFileName = '';
        this.chineseFileName = '';

        // 当前选择的语言和设置
        this.currentLanguage = 'english';

        // API配置（独立版本）
        this.apiConfig = window.SubtitleConfig.normalizeApiConfig(
            window.SubtitleConfig.DEFAULT_API_CONFIG
        );
        this.newApiProviderDraft = null;
        this.isTranslating = false;

        // 使用默认设置初始化（从统一配置中心加载）
        this.englishSettings = getDefaultEnglishSettings();
        this.chineseSettings = getDefaultChineseSettings();

        // UI状态
        this.currentTab = 'files';
        this.advancedExpanded = false;
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
            threadNum: overrides.threadNum ?? 3,
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
        const threadNumValue = document.getElementById('threadNumValue');
        const threadNumHint = document.getElementById('threadNumHint');
        if (!threadNum) return;

        const max = this.getModelConcurrencyLimit(model);
        const normalized = this.normalizeThreadNum(threadNum.value, model);
        if (max === undefined) {
            threadNum.removeAttribute('max');
        } else {
            threadNum.max = String(max);
        }
        threadNum.value = String(normalized);
        if (threadNumValue) threadNumValue.textContent = String(normalized);
        if (threadNumHint) {
            threadNumHint.textContent = max === undefined
                ? '未知模型：使用你填写的并发数；并发越高越容易触发服务端限流'
                : `当前模型上限：${max}；并发越高越容易触发服务端限流`;
        }
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
        this.apiConfig.threadNum = provider.threadNum || 3;
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
        // 从统一配置中心初始化 CSS 变量
        this.initCSSVariablesFromConfig();
        await this.loadThemePreference();

        this.setupTabs();
        this.bindEvents();

        // 监听来自content script的消息（全局监听）
        if (!this.messageListenerBound) {
            chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
                if (request.action === 'autoLoadSuccess') {
                    this.updateAutoLoadStatus('成功: ' + request.filename, 'success');

                    // 🔧 修复：如果消息包含字幕数据，直接使用，否则再同步
                    if (request.englishSubtitles || request.chineseSubtitles || request.subtitleData) {
                        this.englishSubtitles = request.englishSubtitles || [];
                        this.chineseSubtitles = request.chineseSubtitles || [];
                        this.subtitleData = request.subtitleData || [];
                        this.englishFileName = request.englishFileName || '';
                        this.chineseFileName = request.chineseFileName || '';
                        this.currentFileName = request.fileName || '';
                        this.updateSubtitleInfoWithRetry();
                    } else {
                        // 后备方案：从存储中同步数据
                        this.getCurrentVideoInfo();
                    }
                } else if (request.action === 'autoLoadError') {
                    this.updateAutoLoadStatus('失败: ' + request.error, 'error');
                }
            });
            this.messageListenerBound = true;
        }

        // 先确保默认设置写入 storage，再加载当前状态
        try {
            await this.ensureDefaultSettings();
        } catch (e) {
            console.log('确保默认设置时出现问题，但继续加载当前状态:', e);
        }

        await this.loadCurrentState();
        this.setupFileNameTooltips();

        // 初始化API设置
        await this.loadApiConfig();
        this.initApiSettingsUI();

        // 初始化翻译模式
        this.initCurrentVideoState();

        // 主动检查一次当前视频的字幕状态，初始化计数
        this.checkCurrentVideoSubtitleStatus();

        // 监听存储变化，实时更新计数（基于当前视频ID）
        this.observeSubtitleStorageChanges();

        // 检查是否有正在进行的翻译
        this.checkTranslationProgress();

        // 始终监听翻译进度（无论翻译从哪里触发）
        this.startProgressListener();

        // 更新翻译按钮文案
        await this.updateTranslateButton();
    }

    /**
     * 从统一配置中心初始化 CSS 变量
     * 确保 CSS 变量使用的默认值与 config.js 中定义的一致
     */
    initCSSVariablesFromConfig() {
        const config = getDefaultConfig();
        const root = document.documentElement;

        // 英文字幕 CSS 变量
        root.style.setProperty('--english-font-size', config.english.fontSize + 'px');
        root.style.setProperty('--english-font-color', config.english.fontColor);
        root.style.setProperty('--english-font-family', config.english.fontFamily);
        root.style.setProperty('--english-font-weight', config.english.fontWeight);
        root.style.setProperty('--english-text-stroke', config.english.textStroke || 'none');
        root.style.setProperty('--english-text-shadow', config.english.textShadow);
        root.style.setProperty('--english-line-height', config.english.lineHeight);

        // 中文字幕 CSS 变量
        root.style.setProperty('--chinese-font-size', config.chinese.fontSize + 'px');
        root.style.setProperty('--chinese-font-color', config.chinese.fontColor);
        root.style.setProperty('--chinese-font-family', config.chinese.fontFamily);
        root.style.setProperty('--chinese-font-weight', config.chinese.fontWeight);
        root.style.setProperty('--chinese-text-stroke', config.chinese.textStroke || 'none');
        root.style.setProperty('--chinese-text-shadow', config.chinese.textShadow);
        root.style.setProperty('--chinese-line-height', config.chinese.lineHeight);
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
        } catch (error) {
            console.warn('加载主题设置失败，使用系统主题:', error);
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
        } catch (error) {
            console.error('保存主题设置失败:', error);
            Toast.error('主题设置保存失败');
        }
    }

    // 监听chrome.storage变化，保持计数同步与简化更新路径
    observeSubtitleStorageChanges() {
        if (this._storageObserved) return;
        this._storageObserved = true;
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local') return;
            const keys = Object.keys(changes);
            const subtitleResultChanged = keys.some((key) => key.startsWith('videoSubtitles_'))
                || keys.includes('englishSubtitles')
                || keys.includes('chineseSubtitles');
            if (subtitleResultChanged) {
                this.syncSubtitleDataFromContentScript().catch((error) => {
                    console.log('字幕结果变化后同步失败:', error);
                });
            }
        });
    }

    // 确保默认设置存在于storage中
    async ensureDefaultSettings() {
        try {
            const result = await chrome.storage.local.get(['englishSettings', 'chineseSettings']);
            let needsSave = false;

            if (!result.englishSettings || Object.keys(result.englishSettings).length === 0) {
                await chrome.runtime.sendMessage({
                    action: 'updateSettings',
                    settings: {
                        language: 'english',
                        data: this.englishSettings
                    }
                });
                needsSave = true;
            }

            if (!result.chineseSettings || Object.keys(result.chineseSettings).length === 0) {
                await chrome.runtime.sendMessage({
                    action: 'updateSettings',
                    settings: {
                        language: 'chinese',
                        data: this.chineseSettings
                    }
                });
                needsSave = true;
            }

            if (needsSave) {
                // 设置已初始化
            }
        } catch (error) {
            console.log('初始化默认设置失败，但不影响继续使用:', error);
        }
    }

    // ========================================
    // 标签页管理
    // ========================================
    setupTabs() {
        const tabButtons = document.querySelectorAll('.tab-button');
        const tabContents = document.querySelectorAll('.tab-content');

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

        this.currentTab = tabId;
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

        // 文件移除事件
        const englishRemove = document.getElementById('englishRemove');
        const chineseRemove = document.getElementById('chineseRemove');
        const assRemove = document.getElementById('assRemove');

        if (englishRemove) {
            englishRemove.addEventListener('click', () => {
                this.removeFile('english');
            });
        }

        if (chineseRemove) {
            chineseRemove.addEventListener('click', () => {
                this.removeFile('chinese');
            });
        }

        if (assRemove) {
            assRemove.addEventListener('click', () => {
                this.removeASSFile();
            });
        }

        // 设置控件事件
        this.bindSettingsEvents();

        // 翻译按钮和API设置事件
        this.bindTranslateEvents();
        this.bindApiSettingsEvents();
    }

    bindFileUploadEvents(language, uploadAreaId, fileInputId) {
        const uploadArea = document.getElementById(uploadAreaId);
        const fileInput = document.getElementById(fileInputId);

        if (!uploadArea || !fileInput) return;

        // 点击上传
        uploadArea.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => this.handleFileSelect(e, language));

        // 拖拽上传
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                this.processFile(files[0], language);
            }
        });
    }

    bindASSUploadEvents() {
        const assUploadArea = document.getElementById('assUploadArea');
        const assFileInput = document.getElementById('assFileInput');

        if (!assUploadArea || !assFileInput) return;

        // 点击上传
        assUploadArea.addEventListener('click', () => assFileInput.click());
        assFileInput.addEventListener('change', (e) => this.handleASSFileSelect(e));

        // 拖拽上传
        assUploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            assUploadArea.classList.add('dragover');
        });

        assUploadArea.addEventListener('dragleave', () => {
            assUploadArea.classList.remove('dragover');
        });

        assUploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            assUploadArea.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                this.processASSFile(files[0]);
            }
        });
    }

    handleASSFileSelect(event) {
        const file = event.target.files[0];
        if (file) {
            this.processASSFile(file);
        }
    }

    async processASSFile(file) {
        try {
            // 验证文件类型
            if (!file.name.toLowerCase().endsWith('.ass')) {
                throw new Error('请选择ASS格式的字幕文件');
            }

            Toast.show('正在解析ASS双语字幕文件...', 'info');

            // 读取文件内容
            const content = await this.readFileAsText(file);

            // 解析ASS文件，使用统一的 SubtitleParser
            const assResult = SubtitleParser.parseASS(content);

            if (assResult.english.length === 0 && assResult.chinese.length === 0) {
                throw new Error('ASS文件解析失败或未找到有效的双语字幕');
            }

            // 设置字幕数据，但不设置英文和中文的文件名
            this.englishSubtitles = assResult.english;
            this.chineseSubtitles = assResult.chinese;
            // 不设置 englishFileName 和 chineseFileName，避免在分别上传区域显示

            // 获取当前视频ID并保存字幕
            const currentVideoId = await this.getCurrentVideoId();
            let response;

            if (currentVideoId) {
                // 基于视频ID保存字幕
                const targetLangName = this.getTargetLanguageName(this.apiConfig.targetLanguage || 'zh');
                response = await chrome.runtime.sendMessage({
                    action: 'saveVideoSubtitles',
                    videoId: currentVideoId,
                    englishSubtitles: this.englishSubtitles,
                    chineseSubtitles: this.chineseSubtitles,
                    englishFileName: file.name + ' (原语言)',
                    chineseFileName: file.name + ` (${targetLangName})`
                });
            } else {
                // 后备方案：使用旧的保存方式
                response = await chrome.runtime.sendMessage({
                    action: 'saveBilingualSubtitles',
                    englishSubtitles: this.englishSubtitles,
                    chineseSubtitles: this.chineseSubtitles,
                    englishFileName: '', // 清空英文文件名
                    chineseFileName: ''  // 清空中文文件名
                });
            }

            if (response.success) {
                this.updateSubtitleInfoWithRetry();
                this.updateASSFileStatus(file.name, assResult);

                // 更新自动加载状态显示
                this.getCurrentVideoInfo();

                Toast.success(
                    `成功加载ASS双语字幕: ${assResult.english.length} 条英文, ${assResult.chinese.length} 条中文`,
                    'success'
                );

                // 自动启用字幕显示
                const subtitleToggle = document.getElementById('subtitleToggle');
                if (subtitleToggle && !subtitleToggle.checked) {
                    subtitleToggle.checked = true;
                    this.toggleSubtitle(true);
                }
            } else {
                throw new Error(response.error);
            }
        } catch (error) {
            console.error('处理ASS文件失败:', error);
            Toast.error('ASS文件处理失败: ' + error.message);
        }
    }

    updateASSFileStatus(filename, assResult) {
        const assFileStatus = document.getElementById('assFileStatus');
        const assFileName = document.getElementById('assFileName');

        if (assFileStatus && assFileName) {
            // 使用更短的截断长度，更适合界面显示
            const displayName = this.truncateFileName(filename, 18);
            assFileName.textContent = displayName;
            // 设置完整文件名作为title，用于工具提示
            assFileName.setAttribute('title', filename);
            assFileStatus.style.display = 'block';
        }
    }

    removeASSFile() {
        // 清除ASS文件状态显示
        const assFileStatus = document.getElementById('assFileStatus');
        if (assFileStatus) {
            assFileStatus.style.display = 'none';
        }

        // 清除文件输入
        const assFileInput = document.getElementById('assFileInput');
        if (assFileInput) {
            assFileInput.value = '';
        }

        // 清除字幕数据
        this.englishSubtitles = [];
        this.chineseSubtitles = [];
        this.englishFileName = '';
        this.chineseFileName = '';

        // 更新UI显示
        this.updateSubtitleInfoWithRetry();

        // 更新自动加载状态显示
        this.getCurrentVideoInfo();

        // 保存到后台
        chrome.runtime.sendMessage({
            action: 'clearSubtitleData'
        });

        // 注意：不再自动关闭字幕开关，让用户手动控制

        Toast.success('已移除ASS字幕');
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
        } catch (error) {
            console.warn('获取视频ID失败，当前操作无法关联视频:', error);
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
            const currentVideoId = await this.getCurrentVideoId();

            // 加载全局设置
            const globalResponse = await chrome.runtime.sendMessage({ action: 'getBilingualSubtitleData' });
            let videoSubtitles = null;

            // 视频结果由 browser-side Translation session 统一读取
            if (currentVideoId) {
                videoSubtitles = (await this.getTranslationStatus(currentVideoId)).cachedResult;
            }

            if (globalResponse.success) {
                const {
                    subtitleEnabled,
                    englishSettings,
                    chineseSettings
                } = globalResponse.data;

                // 更新UI状态
                const subtitleToggle = document.getElementById('subtitleToggle');
                if (subtitleToggle) subtitleToggle.checked = subtitleEnabled;

                // 优先使用当前视频的字幕数据，否则使用全局数据作为后备
                if (videoSubtitles) {
                    this.subtitleData = videoSubtitles.subtitleData || [];
                    this.englishSubtitles = videoSubtitles.englishSubtitles || [];
                    this.chineseSubtitles = videoSubtitles.chineseSubtitles || [];
                    this.englishFileName = videoSubtitles.englishFileName || '';
                    this.chineseFileName = videoSubtitles.chineseFileName || '';
                    this.currentFileName = videoSubtitles.fileName || '';
                } else {
                    // 使用全局数据作为后备
                    const { subtitleData, englishSubtitles, chineseSubtitles, englishFileName, chineseFileName } = globalResponse.data;
                    this.subtitleData = subtitleData || [];
                    this.englishSubtitles = englishSubtitles || [];
                    this.chineseSubtitles = chineseSubtitles || [];
                    this.englishFileName = englishFileName || '';
                    this.chineseFileName = chineseFileName || '';
                }

                // 定义默认设置（从统一配置中心获取）
                const defaultEnglishSettings = getDefaultEnglishSettings();
                const defaultChineseSettings = getDefaultChineseSettings();

                // 使用默认设置作为后备：当对象为空时回退到默认
                const isEmpty = (obj) => !obj || Object.keys(obj).length === 0;
                this.englishSettings = isEmpty(englishSettings) ? defaultEnglishSettings : englishSettings;
                this.chineseSettings = isEmpty(chineseSettings) ? defaultChineseSettings : chineseSettings;

                // 额外修正：若英文字体为 'inherit' 或缺失，强制回退为默认首选字体
                let needPersistFix = false;
                if (!this.englishSettings.fontFamily || this.englishSettings.fontFamily === 'inherit') {
                    this.englishSettings.fontFamily = defaultEnglishSettings.fontFamily;
                    needPersistFix = true;
                }
                // 额外修正：若中文字幕粗细缺失或为非数值字符串，回退为 900
                if (!this.chineseSettings.fontWeight) {
                    this.chineseSettings.fontWeight = defaultChineseSettings.fontWeight;
                    needPersistFix = true;
                }

                if (needPersistFix) {
                    try {
                        // 持久化修正，避免下次仍显示系统默认
                        await this.updateSettings({ language: 'english', data: { fontFamily: this.englishSettings.fontFamily } });
                        await this.updateSettings({
                            language: 'chinese', data: {
                                fontWeight: this.chineseSettings.fontWeight,
                                fontFamily: this.chineseSettings.fontFamily  // 确保也包含 fontFamily
                            }
                        });
                    } catch (e) {
                        console.warn('持久化默认字体修正失败，不影响前端显示:', e);
                    }
                }

                // 延迟执行字幕统计更新，确保DOM完全就绪
                await this.updateSubtitleInfoWithRetry();

                // 加载当前语言设置到UI
                this.loadLanguageSettingsToUI(this.currentLanguage);
            }
        } catch (error) {
            console.error('加载当前状态失败:', error);
            Toast.error('加载设置失败');
        }
    }

    handleFileSelect(event, language) {
        const file = event.target.files[0];
        if (file) {
            this.processFile(file, language);
        }
    }

    async processFile(file, language) {
        try {
            // 验证文件类型
            if (!this.isValidSubtitleFile(file)) {
                throw new Error('不支持的文件格式，请选择 SRT、VTT 或 ASS 文件');
            }

            Toast.show(`正在解析${language === 'english' ? '英文' : '中文'}字幕文件...`, 'info');

            // 读取文件内容
            const content = await this.readFileAsText(file);

            // 检查是否是ASS文件
            const isASSFile = file.name.split('.').pop().toLowerCase() === 'ass';

            if (isASSFile) {
                // 在分别上传模式中，禁止ASS文件
                throw new Error('ASS文件请使用"双语ASS"上传模式，这里只支持单语SRT/VTT文件');
            }

            // 普通SRT/VTT文件处理
            const subtitleData = this.parseSubtitle(content, file.name);

            if (subtitleData.length === 0) {
                throw new Error('字幕文件解析失败或文件为空');
            }

            // 保存字幕数据
            const currentVideoId = await this.getCurrentVideoId();
            let response;

            if (language === 'english') {
                this.englishSubtitles = subtitleData;
                this.englishFileName = file.name;

                if (currentVideoId) {
                    // 基于视频ID保存字幕
                    response = await chrome.runtime.sendMessage({
                        action: 'saveVideoSubtitles',
                        videoId: currentVideoId,
                        englishSubtitles: this.englishSubtitles,
                        chineseSubtitles: this.chineseSubtitles,
                        englishFileName: this.englishFileName,
                        chineseFileName: this.chineseFileName
                    });
                } else {
                    // 后备方案：使用旧的保存方式
                    response = await chrome.runtime.sendMessage({
                        action: 'saveBilingualSubtitles',
                        englishSubtitles: this.englishSubtitles,
                        chineseSubtitles: this.chineseSubtitles,
                        englishFileName: this.englishFileName,
                        chineseFileName: this.chineseFileName
                    });
                }
            } else {
                this.chineseSubtitles = subtitleData;
                this.chineseFileName = file.name;

                if (currentVideoId) {
                    // 基于视频ID保存字幕
                    response = await chrome.runtime.sendMessage({
                        action: 'saveVideoSubtitles',
                        videoId: currentVideoId,
                        englishSubtitles: this.englishSubtitles,
                        chineseSubtitles: this.chineseSubtitles,
                        englishFileName: this.englishFileName,
                        chineseFileName: this.chineseFileName
                    });
                } else {
                    // 后备方案：使用旧的保存方式
                    response = await chrome.runtime.sendMessage({
                        action: 'saveBilingualSubtitles',
                        englishSubtitles: this.englishSubtitles,
                        chineseSubtitles: this.chineseSubtitles,
                        englishFileName: this.englishFileName,
                        chineseFileName: this.chineseFileName
                    });
                }
            }

            if (response.success) {
                this.updateSubtitleInfoWithRetry();
                this.updateFileCardState(language, true);

                // 更新自动加载状态显示
                this.getCurrentVideoInfo();

                Toast.success(`成功加载 ${subtitleData.length} 条${language === 'english' ? '英文' : '中文'}字幕`);

                // 自动启用字幕显示
                const subtitleToggle = document.getElementById('subtitleToggle');
                if (subtitleToggle && !subtitleToggle.checked) {
                    subtitleToggle.checked = true;
                    this.toggleSubtitle(true);
                }
            } else {
                throw new Error(response.error);
            }

        } catch (error) {
            console.error('处理文件失败:', error);
            Toast.error('文件处理失败: ' + error.message);
        }
    }

    // ========================================
    // 智能文件名处理和工具提示
    // ========================================
    setupFileNameTooltips() {
        const fileNames = document.querySelectorAll('.file-name');
        fileNames.forEach(nameElement => {
            nameElement.addEventListener('mouseenter', (e) => {
                const fullName = e.target.getAttribute('title');
                if (fullName && fullName !== e.target.textContent) {
                    this.showTooltip(e.target, fullName);
                }
            });

            nameElement.addEventListener('mouseleave', () => {
                this.hideTooltip();
            });
        });
    }

    showTooltip(element, text) {
        // 移除现有工具提示
        this.hideTooltip();

        const tooltip = document.createElement('div');
        tooltip.className = 'file-tooltip';
        tooltip.textContent = text;
        tooltip.style.cssText = `
            position: absolute;
            background: #1a1a1a;
            color: white;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 12px;
            z-index: 1000;
            max-width: 300px;
            word-break: break-all;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            pointer-events: none;
        `;

        document.body.appendChild(tooltip);

        const rect = element.getBoundingClientRect();
        tooltip.style.top = (rect.top - tooltip.offsetHeight - 8) + 'px';
        tooltip.style.left = Math.max(8, rect.left) + 'px';

        // 确保工具提示不超出屏幕
        const tooltipRect = tooltip.getBoundingClientRect();
        if (tooltipRect.right > window.innerWidth - 8) {
            tooltip.style.left = (window.innerWidth - tooltipRect.width - 8) + 'px';
        }

        this.currentTooltip = tooltip;
    }

    hideTooltip() {
        if (this.currentTooltip) {
            this.currentTooltip.remove();
            this.currentTooltip = null;
        }
    }

    // 智能截断文件名
    truncateFileName(fileName, maxLength = 25) {
        if (fileName.length <= maxLength) {
            return fileName;
        }

        const extension = fileName.substring(fileName.lastIndexOf('.'));
        const nameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.'));
        const availableLength = maxLength - extension.length - 3; // 3 for "..."

        if (availableLength < 1) {
            return '...' + extension;
        }

        return nameWithoutExt.substring(0, availableLength) + '...' + extension;
    }

    updateFileCardState(language, hasFile) {
        const card = document.getElementById(language + 'Card');
        const fileName = document.getElementById(language + 'FileName');
        const removeBtn = document.getElementById(language + 'Remove');

        // 如果元素不存在则直接返回(UI 已简化)
        if (!card || !fileName || !removeBtn) return;

        if (hasFile) {
            card.classList.add('has-file');
            const fullFileName = language === 'english' ? this.englishFileName : this.chineseFileName;
            const displayName = this.truncateFileName(fullFileName);

            fileName.textContent = displayName;
            fileName.setAttribute('title', fullFileName);
            removeBtn.style.display = 'block';
        } else {
            card.classList.remove('has-file');
            fileName.textContent = '未选择文件';
            fileName.setAttribute('title', '');
            removeBtn.style.display = 'none';
        }
    }

    removeFile(language) {
        if (language === 'english') {
            this.englishSubtitles = [];
            this.englishFileName = '';
        } else {
            this.chineseSubtitles = [];
            this.chineseFileName = '';
        }

        this.updateFileCardState(language, false);
        this.updateSubtitleInfoWithRetry();

        // 更新自动加载状态显示
        this.getCurrentVideoInfo();

        // 保存到后台 - 基于当前视频ID
        this.getCurrentVideoId().then(currentVideoId => {
            if (currentVideoId) {
                // 基于视频ID保存字幕
                chrome.runtime.sendMessage({
                    action: 'saveVideoSubtitles',
                    videoId: currentVideoId,
                    englishSubtitles: this.englishSubtitles,
                    chineseSubtitles: this.chineseSubtitles,
                    englishFileName: this.englishFileName,
                    chineseFileName: this.chineseFileName
                });
            } else {
                // 后备方案：使用旧的保存方式
                chrome.runtime.sendMessage({
                    action: 'saveBilingualSubtitles',
                    englishSubtitles: this.englishSubtitles,
                    chineseSubtitles: this.chineseSubtitles,
                    englishFileName: this.englishFileName,
                    chineseFileName: this.chineseFileName
                });
            }
        });

        Toast.success(`已移除${language === 'english' ? '英文' : '中文'}字幕`);
    }

    // 简化版：直接调用更新方法，避免复杂重试逻辑
    async updateSubtitleInfoWithRetry() {
        this.updateSubtitleInfo();
    }

    updateSubtitleInfo() {
        // 同步文件卡片状态
        this.updateFileCardState('english', !!this.englishFileName);
        this.updateFileCardState('chinese', !!this.chineseFileName);
    }

    // ========================================
    // 其他方法保持不变
    // ========================================

    isValidSubtitleFile(file) {
        const validExtensions = ['srt', 'ass'];
        const extension = file.name.split('.').pop().toLowerCase();
        return validExtensions.includes(extension);
    }

    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsText(file, 'UTF-8');
        });
    }

    parseSubtitle(content, filename) {
        const extension = filename.split('.').pop().toLowerCase();

        try {
            if (extension === 'srt') {
                return SubtitleParser.parseSRT(content);
            } else if (extension === 'ass') {
                return SubtitleParser.parseASS(content);
            } else {
                throw new Error('不支持的文件格式');
            }
        } catch (error) {
            console.error('解析字幕失败:', error);
            return [];
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
            console.error('切换字幕状态失败:', error);
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
        } catch (error) {
            console.warn('更新设置失败，继续使用当前页面设置:', error);
        }
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

    updateAutoLoadStatus(message, type) {
        const autoLoadStatus = document.getElementById('autoLoadStatus');
        if (autoLoadStatus) {
            autoLoadStatus.textContent = message;
            autoLoadStatus.className = `load-status ${type}`;
        }
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
                this.syncSubtitleDataFromContentScript()
                    .catch(error => console.log('字幕数据同步失败，保留当前界面状态:', error));
            });
        } catch (error) {
            console.log('获取视频信息失败，使用空状态继续展示:', error);
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

    async syncSubtitleDataFromContentScript() {
        try {
            // 获取当前视频ID
            const currentVideoId = await this.getCurrentVideoId();

            if (currentVideoId) {
                const videoSubtitles = (await this.getTranslationStatus(currentVideoId)).cachedResult;

                if (videoSubtitles) {
                    // 使用当前视频的字幕数据
                    const oldEnglishCount = this.englishSubtitles.length;
                    const oldChineseCount = this.chineseSubtitles.length;

                    this.subtitleData = videoSubtitles.subtitleData || [];
                    this.englishSubtitles = videoSubtitles.englishSubtitles || [];
                    this.chineseSubtitles = videoSubtitles.chineseSubtitles || [];
                    this.englishFileName = videoSubtitles.englishFileName || '';
                    this.chineseFileName = videoSubtitles.chineseFileName || '';
                    this.currentFileName = videoSubtitles.fileName || '';
                } else {
                    // 当前视频没有字幕数据，清空显示
                    const oldEnglishCount = this.englishSubtitles.length;
                    const oldChineseCount = this.chineseSubtitles.length;

                    this.subtitleData = [];
                    this.englishSubtitles = [];
                    this.chineseSubtitles = [];
                    this.englishFileName = '';
                    this.chineseFileName = '';
                    this.currentFileName = '';
                }
            } else {
                // 无法获取视频ID，使用全局数据作为后备
                const response = await chrome.runtime.sendMessage({ action: 'getBilingualSubtitleData' });
                if (response.success) {
                    const oldEnglishCount = this.englishSubtitles.length;
                    const oldChineseCount = this.chineseSubtitles.length;

                    this.englishSubtitles = response.data.englishSubtitles || [];
                    this.chineseSubtitles = response.data.chineseSubtitles || [];
                    this.englishFileName = response.data.englishFileName || '';
                    this.chineseFileName = response.data.chineseFileName || '';
                }
            }

            // 更新统计显示
            this.updateSubtitleInfoWithRetry();
        } catch (error) {
            console.log('同步字幕数据异常，保留当前界面状态:', error);
        }
    }

    // 🔧 新增：主动检查当前视频的字幕状态
    async checkCurrentVideoSubtitleStatus() {
        try {
            // 获取当前活动的标签页并询问content script
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs.length === 0) return;
            chrome.tabs.sendMessage(tabs[0].id, { action: 'getSubtitleStatus' }, (response) => {
                if (chrome.runtime.lastError || !response) {
                    return;
                }
                if (response.hasSubtitles && (response.englishCount > 0 || response.chineseCount > 0)) {
                    this.syncSubtitleDataFromContentScript()
                        .then(() => this.updateSubtitleInfoWithRetry())
                        .catch(error => console.log('初始化字幕数据同步失败，稍后可重试:', error));
                }
            });

        } catch (error) {
            console.log('检查视频字幕状态失败，稍后可重试:', error);
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
        } catch (error) {
            console.warn('加载API配置失败，继续使用默认配置:', error);
        }
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
            console.error('保存API配置失败:', error);
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
        const threadNumValue = document.getElementById('threadNumValue');

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
            threadNum.value = activeProvider?.threadNum || 3;
            if (threadNumValue) threadNumValue.textContent = threadNum.value;
        }
        this.updateConcurrencyInputLimit(activeProvider?.llmModel || '');
        this.setApiProviderFieldMutability(activeProvider);

        const deleteProviderBtn = document.getElementById('deleteProviderBtn');
        if (deleteProviderBtn) {
            const isDefaultProvider = this.isDefaultApiProvider(activeProvider);
            deleteProviderBtn.disabled = !activeProvider || Boolean(this.newApiProviderDraft) || isDefaultProvider;
            deleteProviderBtn.title = isDefaultProvider ? '内置配置不可删除' : '删除供应商';
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
                } catch (error) {
                    console.warn('保存目标语言失败，当前会话继续使用已选语言:', error);
                }
            });
        }

        // 并发数
        const threadNum = document.getElementById('threadNum');
        const threadNumValue = document.getElementById('threadNumValue');
        if (threadNum) {
            threadNum.addEventListener('input', (e) => {
                const provider = this.getEditingApiProvider();
                if (!provider) return;
                const value = this.normalizeThreadNum(e.target.value, provider.llmModel);
                provider.threadNum = value;
                e.target.value = String(value);
                if (!this.newApiProviderDraft) this.syncActiveProviderFields();
                if (threadNumValue) threadNumValue.textContent = String(value);
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
            Toast.warning('OpenAI、OpenRouter、DeepSeek 为内置配置，不可删除');
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
            await this.requestApiHostPermission(provider.openaiBaseUrl);
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
            await this.requestApiHostPermission(provider.openaiBaseUrl);

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

    requestApiHostPermission(baseUrl) {
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
        } catch (error) {
            console.log('检查翻译进度失败，保持当前界面状态:', error);
        }
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
        if (autoLoadStatus) {
            autoLoadStatus.textContent = '翻译完成!';
            autoLoadStatus.className = 'load-status success';
        }

        if (options.enableSubtitle) {
            const subtitleToggle = document.getElementById('subtitleToggle');
            if (subtitleToggle) subtitleToggle.checked = true;
            await this.toggleSubtitle(true);
        }

        this.resetTranslationButton();
        await this.updateTranslateButton();
        this.updateSubtitleInfoWithRetry();
    }

    startProgressListener() {
        if (this._progressListener) return;

        this._progressListener = async (changes, areaName) => {
            if (areaName !== 'local' || !changes.translationProgress) return;

            const newValue = (await this.getTranslationStatus()).progress;

            if (newValue && newValue.isTranslating) {
                this.showTranslationProgress(newValue);
            } else if (newValue && newValue.error) {
                this.showTranslationError(newValue.error);
                chrome.storage.onChanged.removeListener(this._progressListener);
                this._progressListener = null;
            } else if (newValue && newValue.completed) {
                await this.showTranslationCompleted({ enableSubtitle: true });
                chrome.storage.onChanged.removeListener(this._progressListener);
                this._progressListener = null;
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
        } catch (error) {
            console.log('发送取消消息失败，继续重置 popup UI:', error);
        }

        // 清空当前数据
        this.englishSubtitles = [];
        this.chineseSubtitles = [];

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
            translateBtn.onclick = () => this.startTranslation();
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
        console.log('🎬 startTranslation() 被调用');

        if (this.isTranslating) {
            console.log('⚠️ 翻译正在进行中，忽略重复请求');
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
            await this.requestApiHostPermission(this.apiConfig.openaiBaseUrl);
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
        console.log('📹 当前视频ID:', currentVideoId);

        const translateBtn = document.getElementById('translateBtn');

        console.log('🚀 开始执行翻译流程...');
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
                                console.log('获取视频信息失败，跳过附加元数据:', chrome.runtime.lastError);
                                resolve(null);
                            } else {
                                resolve(response);
                            }
                        });
                    });

                    console.log('📹 获取到的视频信息:', response);

                    if (response) {
                        videoInfo = {
                            ytTitle: response.title,
                            description: response.description,
                            aiSummary: response.aiSummary
                        };
                        console.log('📦 准备传递的视频信息:', videoInfo);
                    }
                } catch (error) {
                    console.log('获取视频信息异常，跳过附加元数据:', error);
                }
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
            console.error('翻译失败:', error);
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

    getTargetLanguageName(langCode) {
        const mapping = {
            'zh': '简体中文',
            'zh-cn': '简体中文',
            'zh-tw': '繁体中文',
            'ja': '日文',
            'en': 'English',
            'ko': '韩文',
            'fr': '法文',
            'de': '德文',
            'es': '西班牙文'
        };
        return mapping[langCode.toLowerCase()] || langCode;
    }

    initCurrentVideoState() {
        // 获取当前视频信息
        this.getCurrentVideoInfo();
    }
}

// 初始化popup控制器
document.addEventListener('DOMContentLoaded', () => {
    // 启动控制器；计数更新由控制器内部统一管理
    new PopupController();
});

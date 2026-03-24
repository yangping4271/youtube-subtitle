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
        this.apiConfig = {
            openaiBaseUrl: 'https://api.openai.com/v1',
            openaiApiKey: '',
            llmModel: '',
            targetLanguage: 'zh',
            threadNum: 3
        };
        this.isTranslating = false;

        // 使用默认设置初始化（从统一配置中心加载）
        this.englishSettings = getDefaultEnglishSettings();
        this.chineseSettings = getDefaultChineseSettings();

        // UI状态
        this.currentTab = 'files';
        this.advancedExpanded = false;

        this.init();
    }

    // 辅助方法：健壮地设置下拉框选中项，确保UI显示同步
    setSelectValue(selectEl, value) {
        if (!selectEl) return;
        const options = Array.from(selectEl.options || []);
        let index = options.findIndex(opt => opt.value === value);
        if (index < 0 && options.length > 0) {
            index = 0; // 回退到第一项
        }
        if (index >= 0) {
            selectEl.selectedIndex = index;
            options.forEach((opt, i) => opt.selected = i === index);
        }
    }

    async init() {
        // 从统一配置中心初始化 CSS 变量
        this.initCSSVariablesFromConfig();

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
            console.warn('确保默认设置时出现问题，但继续加载当前状态:', e);
        }

        await this.loadCurrentState();
        this.setupFileNameTooltips();

        // 初始化API设置
        await this.loadApiConfig();
        this.initApiSettingsUI();

        // 初始化翻译模式
        this.initAutoLoadMode();
        this.checkApiStatus();

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

    // 监听chrome.storage变化，保持计数同步与简化更新路径
    observeSubtitleStorageChanges() {
        if (this._storageObserved) return;
        this._storageObserved = true;
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local') return;
            // 获取当前视频ID后再判断对应键是否变化
            this.getCurrentVideoId().then((videoId) => {
                const videoKey = videoId ? `videoSubtitles_${videoId}` : null;
                const keys = Object.keys(changes);
                // 视频级别数据变化
                if (videoKey && keys.includes(videoKey)) {
                    const data = changes[videoKey].newValue || {};
                    this.englishSubtitles = data.englishSubtitles || [];
                    this.chineseSubtitles = data.chineseSubtitles || [];
                    this.englishFileName = data.englishFileName || '';
                    this.chineseFileName = data.chineseFileName || '';
                    this.updateSubtitleInfo();
                    return;
                }
                // 全局后备数据变化
                if (keys.includes('englishSubtitles') || keys.includes('chineseSubtitles')) {
                    chrome.runtime.sendMessage({ action: 'getBilingualSubtitleData' })
                        .then((res) => {
                            if (res && res.success && !videoKey) {
                                this.englishSubtitles = res.data.englishSubtitles || [];
                                this.chineseSubtitles = res.data.chineseSubtitles || [];
                                this.englishFileName = res.data.englishFileName || '';
                                this.chineseFileName = res.data.chineseFileName || '';
                                this.updateSubtitleInfo();
                            }
                        })
                        .catch(() => { });
                }
            });
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
            console.error('初始化默认设置失败:', error);
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
            console.error('获取视频ID失败:', error);
            return null;
        }
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

            // 如果有当前视频ID，尝试加载对应的字幕数据
            if (currentVideoId) {
                const videoResult = await chrome.storage.local.get(`videoSubtitles_${currentVideoId}`);
                videoSubtitles = videoResult[`videoSubtitles_${currentVideoId}`];
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

                // 🔧 修复：确保执行顺序，避免竞态条件
                await this.loadAutoLoadSettings();

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
            console.error('更新设置失败:', error);
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

    // ========================================
    // 自动加载相关方法
    // ========================================
    bindAutoLoadEvents() {
        // 自动加载开关
        const autoLoadToggle = document.getElementById('autoLoadToggle');
        if (autoLoadToggle) {
            autoLoadToggle.addEventListener('change', (e) => {
                this.toggleAutoLoad(e.target.checked);
            });
        }

        // 服务器地址配置
        const serverUrl = document.getElementById('serverUrl');
        if (serverUrl) {
            serverUrl.addEventListener('change', (e) => {
                this.updateServerUrl(e.target.value);
            });
        }

        // 测试连接按钮
        const testServer = document.getElementById('testServer');
        if (testServer) {
            testServer.addEventListener('click', () => {
                this.testServerConnection();
            });
        }

        // 配置折叠按钮
        const configToggle = document.getElementById('configToggle');
        const configPanel = document.getElementById('configPanel');
        if (configToggle && configPanel) {
            configToggle.addEventListener('click', () => {
                const isExpanded = configPanel.classList.contains('expanded');

                if (isExpanded) {
                    configPanel.classList.remove('expanded');
                    configToggle.classList.remove('expanded');
                } else {
                    configPanel.classList.add('expanded');
                    configToggle.classList.add('expanded');
                }
            });
        }
    }

    initAutoLoadMode() {
        // 获取当前视频信息
        this.getCurrentVideoInfo();
    }

    async loadAutoLoadSettings() {
        try {
            const result = await chrome.storage.local.get(['autoLoadEnabled', 'serverUrl']);
            this.autoLoadEnabled = result.autoLoadEnabled || false;
            this.serverUrl = result.serverUrl || 'http://127.0.0.1:8888';

            const autoLoadToggle = document.getElementById('autoLoadToggle');
            const serverUrlInput = document.getElementById('serverUrl');

            if (autoLoadToggle) autoLoadToggle.checked = this.autoLoadEnabled;
            if (serverUrlInput) serverUrlInput.value = this.serverUrl;

            // 🔧 修复：主动检测服务器状态
            await this.checkServerStatus();

        } catch (error) {
            console.error('加载自动加载设置失败:', error);
            this.updateServerStatus('error', '设置加载失败', error.message);
        }
    }

    async toggleAutoLoad(enabled) {
        this.autoLoadEnabled = enabled;

        try {
            // 保存设置
            await chrome.storage.local.set({ autoLoadEnabled: enabled });

            // 通知content script
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        action: 'toggleAutoLoad',
                        enabled: enabled
                    });
                }
            });

            Toast.show(
                enabled ? '自动加载已启用' : '自动加载已禁用',
                enabled ? 'success' : 'info'
            );

            if (enabled) {
                this.checkServerStatus();
            }

        } catch (error) {
            console.error('切换自动加载状态失败:', error);
            Toast.error('设置失败: ' + error.message);
        }
    }

    async updateServerUrl(url) {
        this.serverUrl = url;

        try {
            await chrome.storage.local.set({ serverUrl: url });

            // 通知content script
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        action: 'updateServerUrl',
                        url: url
                    });
                }
            });
        } catch (error) {
            console.error('更新服务器地址失败:', error);
        }
    }

    async checkServerStatus() {
        // 设置检查状态
        this.updateServerStatus('connecting', '检查服务器状态中...');

        try {
            const response = await fetch(`${this.serverUrl}/health`, {
                method: 'GET',
                timeout: 5000
            });

            if (response.ok) {
                const result = await response.json();
                this.updateServerStatus('connected', '服务器已连接');
            } else {
                this.updateServerStatus('error', `服务器错误 (${response.status})`);
            }

        } catch (error) {
            this.updateServerStatus('error', '服务器连接失败');
        }
    }

    updateServerStatus(status, message) {
        this.serverStatus = status;

        const statusText = document.getElementById('statusText');
        const statusSubtext = document.getElementById('statusSubtext');
        const statusCircle = document.querySelector('.status-circle');
        const statusIcon = document.getElementById('statusIcon');

        // 更新主状态文本
        if (statusText) statusText.textContent = message;

        // 根据状态更新圆圈样式和图标
        if (statusCircle && statusIcon) {
            statusCircle.className = `status-circle ${status}`;

            switch (status) {
                case 'connected':
                    statusIcon.textContent = '✅';
                    if (statusSubtext) statusSubtext.textContent = '服务器运行正常';
                    break;
                case 'disconnected':
                case 'error':
                    statusIcon.textContent = '❌';
                    if (statusSubtext) statusSubtext.textContent = '无法连接到服务器';
                    break;
                case 'connecting':
                    statusIcon.textContent = '⚡';
                    if (statusSubtext) statusSubtext.textContent = '正在检查连接状态';
                    break;
                default:
                    statusIcon.textContent = '❓';
                    if (statusSubtext) statusSubtext.textContent = '服务器状态未知';
            }
        }
    }

    async testServerConnection() {
        const testButton = document.getElementById('testServer');
        const testText = testButton?.querySelector('.test-text');
        const originalText = testText?.textContent || '测试';

        if (testButton && testText) {
            testText.textContent = '测试中...';
            testButton.disabled = true;
            testButton.style.opacity = '0.6';
        }

        await this.checkServerStatus();

        if (testButton && testText) {
            testText.textContent = originalText;
            testButton.disabled = false;
            testButton.style.opacity = '1';
        }

        // 显示测试结果
        if (this.serverStatus === 'connected') {
            Toast.success('服务器连接正常');
        } else {
            Toast.error('服务器连接失败，请检查服务器是否启动');
        }
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
                    .catch(error => console.error('❌ 字幕数据同步失败:', error));
            });
        } catch (error) {
            console.error('获取视频信息失败:', error);
            this.updateVideoDisplay(null, '获取失败');
        }
    }

    updateVideoDisplay(videoId, status) {
        const videoIdElement = document.getElementById('currentVideoId');
        const statusElement = document.getElementById('autoLoadStatus');

        if (videoIdElement) {
            videoIdElement.textContent = videoId || '未检测到视频';
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
                // 优先从基于videoId的存储中获取数据
                const videoResult = await chrome.storage.local.get(`videoSubtitles_${currentVideoId}`);
                const videoSubtitles = videoResult[`videoSubtitles_${currentVideoId}`];

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
            console.error('❌ 同步字幕数据异常:', error);
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
                        .catch(error => console.error('❌ 初始化字幕数据同步失败:', error));
                }
            });

        } catch (error) {
            console.error('❌ 检查视频字幕状态失败:', error);
        }
    }

    // ========================================
    // API配置管理（独立版本专用）
    // ========================================

    async loadApiConfig() {
        try {
            const result = await chrome.storage.local.get(['apiConfig']);
            if (result.apiConfig) {
                this.apiConfig = { ...this.apiConfig, ...result.apiConfig };
            }
        } catch (error) {
            console.error('加载API配置失败:', error);
        }
    }

    async saveApiConfig() {
        try {
            await chrome.storage.local.set({ apiConfig: this.apiConfig });
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
        const apiBaseUrl = document.getElementById('apiBaseUrl');
        const apiKey = document.getElementById('apiKey');
        const llmModel = document.getElementById('llmModel');
        const targetLanguage = document.getElementById('targetLanguage');
        const threadNum = document.getElementById('threadNum');
        const threadNumValue = document.getElementById('threadNumValue');

        if (apiBaseUrl) apiBaseUrl.value = this.apiConfig.openaiBaseUrl;
        if (apiKey) apiKey.value = this.apiConfig.openaiApiKey;
        if (llmModel) llmModel.value = this.apiConfig.llmModel;
        if (targetLanguage) this.setSelectValue(targetLanguage, this.apiConfig.targetLanguage);
        if (threadNum) {
            threadNum.value = this.apiConfig.threadNum || 3;
            if (threadNumValue) threadNumValue.textContent = threadNum.value;
        }

        // 检查API状态
        if (this.apiConfig.openaiApiKey) {
            this.checkApiStatus();
        }
    }

    bindApiSettingsEvents() {
        // API Base URL
        const apiBaseUrl = document.getElementById('apiBaseUrl');
        if (apiBaseUrl) {
            apiBaseUrl.addEventListener('change', (e) => {
                this.apiConfig.openaiBaseUrl = e.target.value.trim();
            });
        }

        // API Key
        const apiKey = document.getElementById('apiKey');
        if (apiKey) {
            apiKey.addEventListener('change', (e) => {
                this.apiConfig.openaiApiKey = e.target.value.trim();
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
                this.apiConfig.llmModel = e.target.value.trim();
            });
        }

        // 目标语言
        const targetLanguage = document.getElementById('targetLanguage');
        if (targetLanguage) {
            targetLanguage.addEventListener('change', (e) => {
                this.apiConfig.targetLanguage = e.target.value;
            });
        }

        // 并发数
        const threadNum = document.getElementById('threadNum');
        const threadNumValue = document.getElementById('threadNumValue');
        if (threadNum) {
            threadNum.addEventListener('input', (e) => {
                const value = parseInt(e.target.value, 10);
                this.apiConfig.threadNum = value;
                if (threadNumValue) threadNumValue.textContent = value;
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

        // 自动翻译模式中的测试按钮
        const testServer = document.getElementById('testServer');
        if (testServer) {
            testServer.addEventListener('click', () => this.testApiConnection());
        }
    }

    async saveApiConfigFromUI() {
        // 从UI收集配置
        const apiBaseUrl = document.getElementById('apiBaseUrl');
        const apiKey = document.getElementById('apiKey');
        const llmModel = document.getElementById('llmModel');
        const targetLanguage = document.getElementById('targetLanguage');
        const threadNum = document.getElementById('threadNum');

        if (apiBaseUrl) this.apiConfig.openaiBaseUrl = apiBaseUrl.value.trim();
        if (apiKey) this.apiConfig.openaiApiKey = apiKey.value.trim();
        if (llmModel) this.apiConfig.llmModel = llmModel.value.trim();
        if (targetLanguage) this.apiConfig.targetLanguage = targetLanguage.value;
        if (threadNum) this.apiConfig.threadNum = parseInt(threadNum.value, 10) || 3;

        await this.saveApiConfig();
    }

    async testApiConnection() {
        this.showApiStatus('loading', '测试连接中...');

        // 临时更新translator配置
        if (typeof translatorService !== 'undefined') {
            await chrome.storage.local.set({ apiConfig: this.apiConfig });
        }

        try {
            const response = await fetch(`${this.apiConfig.openaiBaseUrl}/models`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.apiConfig.openaiApiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                this.showApiStatus('success', 'API连接成功');
                this.updateTranslateStatus('connected', 'API已连接', '可以开始翻译');
            } else {
                const error = await response.json().catch(() => ({}));
                this.showApiStatus('error', `连接失败: ${error.error?.message || response.statusText}`);
                this.updateTranslateStatus('error', 'API连接失败', '请检查配置');
            }
        } catch (error) {
            this.showApiStatus('error', `网络错误: ${error.message}`);
            this.updateTranslateStatus('error', '网络错误', error.message);
        }
    }

    showApiStatus(type, message) {
        const apiStatus = document.getElementById('apiStatus');
        const apiStatusIcon = document.getElementById('apiStatusIcon');
        const apiStatusText = document.getElementById('apiStatusText');

        if (apiStatus) {
            apiStatus.style.display = 'flex';
            apiStatus.className = `api-status ${type}`;
        }
        if (apiStatusIcon) {
            apiStatusIcon.textContent = type === 'success' ? '✓' : type === 'error' ? '✗' : '⏳';
        }
        if (apiStatusText) {
            apiStatusText.textContent = message;
        }
    }

    checkApiStatus() {
        if (this.apiConfig.openaiApiKey) {
            this.updateTranslateStatus('ready', 'API已配置', '点击按钮开始翻译');
        } else {
            this.updateTranslateStatus('unconfigured', '未配置API', '请在API设置中配置');
        }
    }

    updateTranslateStatus(status, title, subtitle) {
        const statusIcon = document.getElementById('statusIcon');
        const statusText = document.getElementById('statusText');
        const statusSubtext = document.getElementById('statusSubtext');

        if (statusIcon) {
            const icons = {
                'connected': '✅',
                'ready': '🔑',
                'unconfigured': '⚠️',
                'translating': '⏳',
                'error': '❌',
                'success': '✅'
            };
            statusIcon.textContent = icons[status] || '🔑';
        }
        if (statusText) statusText.textContent = title;
        if (statusSubtext) statusSubtext.textContent = subtitle;
    }

    // ========================================
    // 翻译功能（独立版本专用）
    // ========================================

    /**
     * 检查是否有正在进行的翻译,如果有则恢复进度条显示
     */
    async checkTranslationProgress() {
        try {
            const result = await chrome.storage.local.get(['translationProgress']);
            const progress = result.translationProgress;

            if (progress && progress.isTranslating) {
                // 检查翻译是否超时(超过10分钟视为异常)
                const elapsed = Date.now() - progress.timestamp;
                if (elapsed > 10 * 60 * 1000) {
                    await chrome.storage.local.remove('translationProgress');
                    return;
                }

                this.isTranslating = true;
                this.showTranslationProgress(progress);
                this.startProgressListener();
            }
        } catch (error) {
            console.error('检查翻译进度失败:', error);
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
            translateBtn.innerHTML = '<span>❌ 取消翻译</span>';
            translateBtn.classList.add('translating');
            // 绑定取消事件(只绑定一次)
            if (!translateBtn._cancelBound) {
                translateBtn._cancelBound = true;
                translateBtn._originalClick = translateBtn.onclick;
                translateBtn.onclick = () => this.forceResetTranslation();
            }
        }
        if (progressRow) progressRow.style.display = 'flex';

        const percent = Math.round((progress.current / progress.total) * 100);
        if (progressFill) progressFill.style.width = percent + '%';

        const stepNames = {
            'split': '断句优化中...',
            'summary': '内容总结中...',
            'translate': '翻译中...',
            'complete': '完成'
        };
        if (progressText) progressText.textContent = `${percent}%`;
        if (autoLoadStatus) autoLoadStatus.textContent = stepNames[progress.step] || progress.step;
    }

    startProgressListener() {
        if (this._progressListener) return;

        this._progressListener = async (changes, areaName) => {
            if (areaName !== 'local' || !changes.translationProgress) return;

            const newValue = changes.translationProgress.newValue;
            const autoLoadStatus = document.getElementById('autoLoadStatus');

            if (newValue && newValue.isTranslating) {
                this.showTranslationProgress(newValue);
            } else if (newValue && newValue.error) {
                // 翻译失败
                if (autoLoadStatus) {
                    autoLoadStatus.textContent = `翻译失败: ${newValue.error}`;
                    autoLoadStatus.className = 'load-status error';
                }
                this.resetTranslationButton();
                await this.updateTranslateButton();
                chrome.storage.onChanged.removeListener(this._progressListener);
                this._progressListener = null;
            } else {
                // 翻译完成
                if (autoLoadStatus) {
                    autoLoadStatus.textContent = '翻译完成!';
                    autoLoadStatus.className = 'load-status success';
                }

                // 启用字幕显示
                const subtitleToggle = document.getElementById('subtitleToggle');
                if (subtitleToggle) subtitleToggle.checked = true;
                await this.toggleSubtitle(true);

                this.resetTranslationButton();
                await this.updateTranslateButton();
                this.updateSubtitleInfoWithRetry();
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
        // 发送取消消息到后台
        try {
            await chrome.runtime.sendMessage({ action: 'cancelTranslation' });
        } catch (error) {
            console.warn('发送取消消息失败:', error);
        }

        // 清除当前视频的缓存
        const currentVideoId = await this.getCurrentVideoId();
        if (currentVideoId) {
            const cacheKey = `videoSubtitles_${currentVideoId}`;
            await chrome.storage.local.remove([cacheKey]);
        }

        // 清空页面字幕
        try {
            await chrome.runtime.sendMessage({
                action: 'clearSubtitleData'
            });
        } catch (error) {
            console.warn('清除页面字幕失败:', error);
        }

        // 清空当前数据
        this.englishSubtitles = [];
        this.chineseSubtitles = [];

        // 清除翻译进度
        await chrome.storage.local.remove('translationProgress');

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
            translateBtn.innerHTML = '<span>🚀 开始翻译</span>';
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
            translateBtn.innerHTML = '<span class="btn-icon">🚀</span><span class="btn-text">开始翻译</span>';
            return;
        }

        const cacheKey = `videoSubtitles_${currentVideoId}`;
        const result = await chrome.storage.local.get([cacheKey]);
        const cached = result[cacheKey];

        if (cached && (cached.englishSubtitles?.length > 0 || cached.chineseSubtitles?.length > 0)) {
            translateBtn.innerHTML = '<span class="btn-icon">🔄</span><span class="btn-text">重新翻译</span>';
        } else {
            translateBtn.innerHTML = '<span class="btn-icon">🚀</span><span class="btn-text">开始翻译</span>';
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
        if (!this.apiConfig.openaiApiKey) {
            const autoLoadStatus = document.getElementById('autoLoadStatus');
            if (autoLoadStatus) {
                autoLoadStatus.textContent = '请先配置API密钥';
                autoLoadStatus.className = 'load-status error';
            }
            this.switchTab('api');
            return;
        }

        // 获取当前视频ID
        const currentVideoId = await this.getCurrentVideoId();
        console.log('📹 当前视频ID:', currentVideoId);

        // 检查按钮文案判断是否为重新翻译
        const translateBtn = document.getElementById('translateBtn');
        const isRetranslate = translateBtn && translateBtn.textContent.includes('重新翻译');
        console.log('🔄 是否重新翻译:', isRetranslate, '按钮文案:', translateBtn?.textContent);

        // 如果是重新翻译，先完全重置
        if (isRetranslate && currentVideoId) {
            console.log('🧹 开始清理缓存和重置状态...');
            try {
                // 清理缓存
                const cacheKey = `videoSubtitles_${currentVideoId}`;
                await chrome.storage.local.remove([cacheKey]);
                console.log('✅ 缓存已清除:', cacheKey);

                // 清空页面字幕
                try {
                    await chrome.runtime.sendMessage({
                        action: 'clearSubtitleData'
                    });
                    console.log('✅ 页面字幕已清空');
                } catch (error) {
                    console.warn('⚠️ 清空页面字幕失败:', error);
                }

                // 清空当前数据
                this.englishSubtitles = [];
                this.chineseSubtitles = [];

                // 重置进度条
                const progressFill = document.getElementById('progressFill');
                const progressText = document.getElementById('progressText');
                if (progressFill) progressFill.style.width = '0%';
                if (progressText) progressText.textContent = '0%';

                // 更新状态显示
                const autoLoadStatus = document.getElementById('autoLoadStatus');
                if (autoLoadStatus) {
                    autoLoadStatus.textContent = '正在准备重新翻译...';
                    autoLoadStatus.className = 'load-status translating';
                }

                console.log('✅ 清理完成，继续执行翻译流程');
            } catch (error) {
                console.error('❌ 清理缓存时出错:', error);
                const autoLoadStatus = document.getElementById('autoLoadStatus');
                if (autoLoadStatus) {
                    autoLoadStatus.textContent = `清理失败: ${error.message}`;
                    autoLoadStatus.className = 'load-status error';
                }
                return;
            }
        }

        // 检查是否已有翻译缓存（重新翻译时已清除）
        if (!isRetranslate && currentVideoId) {
            const cacheKey = `videoSubtitles_${currentVideoId}`;
            const result = await chrome.storage.local.get([cacheKey]);
            const cached = result[cacheKey];

            if (cached && (cached.englishSubtitles?.length > 0 || cached.chineseSubtitles?.length > 0)) {
                console.log('📦 发现已有翻译缓存:', cached.englishSubtitles?.length, '条英文,', cached.chineseSubtitles?.length, '条中文');

                // 直接加载缓存的翻译
                this.englishSubtitles = cached.englishSubtitles || [];
                this.chineseSubtitles = cached.chineseSubtitles || [];

                const targetLangName = this.getTargetLanguageName(this.apiConfig.targetLanguage || 'zh');
                // 通知content.js加载字幕
                await chrome.runtime.sendMessage({
                    action: 'saveBilingualSubtitles',
                    englishSubtitles: cached.englishSubtitles,
                    chineseSubtitles: cached.chineseSubtitles,
                    englishFileName: cached.englishFileName || 'YouTube字幕 (原语言)',
                    chineseFileName: cached.chineseFileName || `AI翻译 (${targetLangName})`
                });

                // 启用字幕显示
                const subtitleToggle = document.getElementById('subtitleToggle');
                if (subtitleToggle) subtitleToggle.checked = true;
                await this.toggleSubtitle(true);

                this.updateSubtitleInfoWithRetry();

                // 更新状态显示
                const autoLoadStatus = document.getElementById('autoLoadStatus');
                if (autoLoadStatus) {
                    autoLoadStatus.textContent = `已加载缓存: ${cached.chineseSubtitles?.length || 0}条字幕`;
                    autoLoadStatus.className = 'load-status success';
                }
                return;
            }
        }

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
                translateBtn.innerHTML = '<span>❌ 取消翻译</span>';
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
                                console.warn('获取视频信息失败:', chrome.runtime.lastError);
                                resolve(null);
                            } else {
                                resolve(response);
                            }
                        });
                    });

                    console.log('📹 获取到的视频信息:', response);

                    if (response) {
                        videoInfo = {
                            title: response.title,
                            description: response.description,
                            aiSummary: response.aiSummary
                        };
                        console.log('📦 准备传递的视频信息:', videoInfo);
                    }
                } catch (error) {
                    console.warn('获取视频信息异常:', error);
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

    async translateSubtitlesWithProgress(subtitles, onProgress) {
        const batchSize = 15;
        const englishSubtitles = [];
        const chineseSubtitles = [];

        const targetLanguageName = this.getTargetLanguageName(this.apiConfig.targetLanguage);

        for (let i = 0; i < subtitles.length; i += batchSize) {
            const batch = subtitles.slice(i, i + batchSize);

            // 构建批次对象
            const batchObj = {};
            batch.forEach((sub, idx) => {
                batchObj[String(i + idx + 1)] = sub.text;
            });

            // 调用翻译API
            const translations = await this.callTranslateApi(batchObj, targetLanguageName);

            // 处理翻译结果
            batch.forEach((sub, idx) => {
                const key = String(i + idx + 1);
                const translation = translations[key] || '';

                englishSubtitles.push({
                    start: sub.start,
                    end: sub.end,
                    text: sub.text
                });

                chineseSubtitles.push({
                    start: sub.start,
                    end: sub.end,
                    text: translation
                });
            });

            // 进度回调
            if (onProgress) {
                onProgress(Math.min(i + batchSize, subtitles.length), subtitles.length);
            }

            // 延迟避免限流
            if (i + batchSize < subtitles.length) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        return { english: englishSubtitles, chinese: chineseSubtitles };
    }

    async callTranslateApi(batchObj, targetLanguage) {
        const systemPrompt = `You are an expert subtitle translator. Translate the following subtitles into ${targetLanguage}.

Return translations using XML-style numbered tags. Each tag number must match the input subtitle key exactly.

Example:
<1>翻译内容</1>
<2>翻译内容</2>

Return ONLY the XML tags, no other text.`;

        const response = await fetch(`${this.apiConfig.openaiBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiConfig.openaiApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: this.apiConfig.llmModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: JSON.stringify(batchObj) }
                ],
                temperature: 0.3
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `API错误: ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices[0]?.message?.content || '';

        // 用正则解析 XML 标签格式: <1>翻译内容</1>
        const result = {};
        const xmlRegex = /<(\d+)>([\s\S]*?)<\/\1>/g;
        let match;
        while ((match = xmlRegex.exec(content)) !== null) {
            result[match[1]] = match[2].trim();
        }
        return result;
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

    initAutoLoadMode() {
        // 获取当前视频信息
        this.getCurrentVideoInfo();
        this.checkApiStatus();
    }
}

// 初始化popup控制器
document.addEventListener('DOMContentLoaded', () => {
    // 启动控制器；计数更新由控制器内部统一管理
    new PopupController();
});

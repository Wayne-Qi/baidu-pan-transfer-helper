// ==UserScript==
// @name         百度网盘转存助手（by Qi）
// @namespace    https://github.com/Wayne-Qi
// @version      1.1
// @author       Qi
// @description  基于稳定内核，优化文件夹转存策略（预分块），支持自动建文件夹、记忆设置、完成提示音
// @supportURL   tencent://message/?uin=544439919
// @match        *://pan.baidu.com/disk/home*
// @match        *://yun.baidu.com/disk/home*
// @match        *://pan.baidu.com/disk/main*
// @match        *://yun.baidu.com/disk/main*
// @match        https://pan.baidu.com/s/*
// @match        https://yun.baidu.com/s/*
// @require      https://unpkg.com/jquery@3.7.0/dist/jquery.min.js
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @run-at       document-end
// @all-frames   true
// @license MIT
// ==/UserScript==

(function () {
    'use strict';

    // ================================================================
    // 0. 辅助工具：提示音（Web Audio 生成，无需外部文件）
    // ================================================================
    function playBeep() {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            oscillator.frequency.value = 880;
            oscillator.type = 'sine';
            gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
            oscillator.start(audioCtx.currentTime);
            oscillator.stop(audioCtx.currentTime + 0.3);
        } catch (e) {}
    }

    // ================================================================
    // 1. 核心转存类
    // ================================================================
    window.BaiduTransfer = function (rootPath) {
        this.ROOT_URL = 'https://pan.baidu.com';
        this.bdstoken = null;
        this.shareId = null;
        this.shareRoot = null;
        this.userId = null;
        this.dirList = [];
        this.fileList = [];
        this.rootPath = rootPath || "";
        this.maxRetries = 5;
        this.cancel = false;
        this.onProgress = null;
        this.onLog = null;
        this.totalFiles = 0;
        this.transferredFiles = 0;
    };

    BaiduTransfer.prototype = {

        request: async function (path, method, params, data, checkErrno) {
            var url = this.ROOT_URL + path;
            if (params) {
                url += '?' + params;
            }
            try {
                var response = await $.ajax({
                    url: url,
                    type: method,
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                    data: data,
                    xhrFields: { withCredentials: true }
                });
                if (checkErrno && response.errno && response.errno !== 0) {
                    var errno = response.errno;
                    var errmsg = response.show_msg || "过5分钟重试";
                    var customError = new Error(errmsg);
                    customError.errno = errno;
                    throw customError;
                }
                return response;
            } catch (error) {
                throw error;
            }
        },

        createDirectory: async function (dirPath) {
            try {
                await this.listDir(dirPath);
                return;
            } catch (error) {
                if (error.errno !== -9) {
                    throw error;
                }
            }
            var path = "/api/create";
            var params = "a=commit&bdstoken=" + this.bdstoken;
            var data = "path=" + encodeURIComponent(dirPath) + "&isdir=1&block_list=[]";
            return await this.request(path, "POST", params, data, true);
        },

        listDir: async function (dirPath) {
            var path = "/api/list";
            var params = "order=time&desc=1&showempty=0&page=1&num=1000&dir=" + this.customUrlEncode(dirPath) + "&bdstoken=" + this.bdstoken;
            return await this.request(path, "GET", params, null, true);
        },

        transfer: async function (userId, shareId, fsidList, transferPath, retryCount = 0) {
            if (this.cancel) throw new Error('操作已取消');

            var path = "/share/transfer";
            var params = "shareid=" + shareId + "&from=" + userId + "&ondup=newcopy&channel=chunlei&bdstoken=" + this.bdstoken;
            var data = "fsidlist=[" + fsidList.join(",") + "]&path=" + encodeURIComponent(transferPath || "/");

            try {
                var response = await this.request(path, "POST", params, data, false);
                var errno = response.errno;
                if (errno !== 0) {
                    if (errno === 2) {
                        var error = new Error("APIParameterError: url=" + path + " param=" + params);
                        throw error;
                    } else if (errno === 12) {
                        var limit = response.target_file_nums_limit;
                        var count = response.target_file_nums;
                        if (limit && count) {
                            var error = new Error("TransferLimitExceededException: limit=" + limit + " count=" + count);
                            throw error;
                        }
                        var error = new Error(response.show_msg);
                        throw error;
                    } else if (errno === 1504) {
                        if (this.onLog) this.onLog(`⏳ 超时重试 (${retryCount+1}/${this.maxRetries})`);
                        if (retryCount < this.maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            return await this.transfer(userId, shareId, fsidList, transferPath, retryCount + 1);
                        } else {
                            var error = new Error("Transfer timeout after maximum retries");
                            throw error;
                        }
                    } else if (errno === 111) {
                        if (this.onLog) this.onLog(`⏳ API限流，等待15秒... (${retryCount+1}/${this.maxRetries})`);
                        if (retryCount < this.maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 15000));
                            return await this.transfer(userId, shareId, fsidList, transferPath, retryCount + 1);
                        } else {
                            var error = new Error("API rate limit exceeded after maximum retries");
                            throw error;
                        }
                    } else if (errno === -6 || errno === -9 || errno === 130) {
                        if (this.onLog) this.onLog(`⏳ 网络错误，重试 (${retryCount+1}/${this.maxRetries})`);
                        if (retryCount < this.maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 3000));
                            return await this.transfer(userId, shareId, fsidList, transferPath, retryCount + 1);
                        } else {
                            var error = new Error(`Network/Server error after maximum retries: errno=${errno}`);
                            throw error;
                        }
                    } else {
                        var error = new Error("BaiduYunPanAPIException: [" + errno + "] " + response.errmsg);
                        throw error;
                    }
                }
                this.transferredFiles += fsidList.length;
                if (this.onProgress) {
                    this.onProgress(this.transferredFiles, this.totalFiles);
                }
                if (this.onLog) this.onLog(`✅ 成功转存 ${fsidList.length} 个文件/文件夹`);
                return response;
            } catch (error) {
                if (retryCount < this.maxRetries && (error.message.includes('timeout') || error.message.includes('Network'))) {
                    if (this.onLog) this.onLog(`⏳ 网络超时，重试 (${retryCount+1}/${this.maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    return await this.transfer(userId, shareId, fsidList, transferPath, retryCount + 1);
                }
                throw error;
            }
        },

        getBdstoken: async function () {
            if (this.bdstoken) {
                return this.bdstoken;
            }
            var path = "/api/gettemplatevariable";
            var params = "fields=[\"bdstoken\"]";
            var response = await this.request(path, "GET", params, null, true);
            this.bdstoken = response.result.bdstoken;
            return this.bdstoken;
        },

        getRandsk: async function (shareKey, pwd) {
            var path = "/share/verify";
            var params = "surl=" + shareKey + "&bdstoken=" + this.bdstoken;
            var data = "pwd=" + pwd;
            var response = await this.request(path, "POST", params, data, true);
            return response.randsk;
        },

        getShareData: async function (shareKey, pwd) {
            var path = "/s/1" + shareKey;
            var response = await this.request(path, "GET", null, null, false);
            var startTag = 'locals.mset(';
            var endTag = '});';
            var startIndex = response.indexOf(startTag);
            if (startIndex === -1) {
                throw new Error("Invalid response: unable to find locals.mset");
            }
            startIndex += startTag.length;
            var endIndex = response.indexOf(endTag, startIndex);
            if (endIndex === -1) {
                throw new Error("Invalid response: unable to find end of locals.mset");
            }
            var jsonStr = response.substring(startIndex, endIndex + 1);
            var data = JSON.parse(jsonStr);
            return {
                userId: data.share_uk,
                shareId: data.shareid,
                bdstoken: data.bdstoken,
                shareRoot: data.file_list[0].parent_path,
                dirList: data.file_list.filter(e => e.isdir === 1).map(function (file) {
                    return { id: file.fs_id, name: file.server_filename };
                }),
                fileList: data.file_list.filter(e => e.isdir !== 1).map(function (file) {
                    return { id: file.fs_id, name: file.server_filename };
                })
            };
        },

        updateRandsk: async function (shareKey, pwd) {
            await this.getBdstoken();
            await this.getRandsk(shareKey, pwd);
        },

        initShareData: async function (shareKey, pwd) {
            if (pwd) {
                await this.updateRandsk(shareKey, pwd);
            }
            try {
                var shareData = await this.getShareData(shareKey, pwd);
                this.userId = shareData.userId;
                this.shareId = shareData.shareId;
                this.bdstoken = shareData.bdstoken;
                this.shareRoot = shareData.shareRoot;
                this.dirList = shareData.dirList;
                this.fileList = shareData.fileList;
                this.totalFiles = this.dirList.length + this.fileList.length;
            } catch (error) {
                if (error.message.indexOf('/share/init')) {
                    if (pwd) {
                        throw new Error("Wrong password: " + pwd);
                    } else {
                        throw new Error("Password not specified");
                    }
                }
                throw error;
            }
        },

        transferFiles: async function (fileList, targetPath, retryCount = 0) {
            if (this.cancel) throw new Error('操作已取消');
            if (targetPath) {
                await this.createDirectory(targetPath);
            }
            var maxTransferCount = 100;
            try {
                for (var i = 0; i < fileList.length; i += maxTransferCount) {
                    if (this.cancel) throw new Error('操作已取消');
                    var batch = fileList.slice(i, i + maxTransferCount);
                    var fsidList = batch.map(function (file) { return file.id; });
                    await this.transfer(this.userId, this.shareId, fsidList, targetPath);
                }
                if (this.onLog) this.onLog(`✅ 文件转存完成 (${fileList.length} 个)`);
            } catch (error) {
                if (retryCount < this.maxRetries && !this.cancel) {
                    if (this.onLog) this.onLog(`⏳ 文件转存失败，重试 (${retryCount+1}/${this.maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    return await this.transferFiles(fileList, targetPath, retryCount + 1);
                } else {
                    throw error;
                }
            }
        },

        transferDirs: async function (dirList, targetPath, retryCount = 0) {
            if (this.cancel) throw new Error('操作已取消');
            if (targetPath) {
                await this.createDirectory(targetPath);
            }
            if (dirList.length === 0) {
                return;
            }

            const MAX_BATCH = 100;
            const chunks = [];
            for (let i = 0; i < dirList.length; i += MAX_BATCH) {
                chunks.push(dirList.slice(i, i + MAX_BATCH));
            }

            if (this.onLog) this.onLog(`📦 文件夹分 ${chunks.length} 批转存（每批≤100个）`);

            for (let chunk of chunks) {
                if (this.cancel) throw new Error('操作已取消');

                try {
                    await this.transfer(this.userId, this.shareId, chunk.map(dir => dir.id), targetPath);
                    if (this.onLog) this.onLog(`✅ 成功转存 ${chunk.length} 个文件夹`);
                } catch (error) {
                    if (error.message.includes('TransferLimitExceededException:')) {
                        if (this.onLog) this.onLog(`⚠️ 批次超限，递归拆分 (${chunk.length} 个)`);
                        if (chunk.length >= 2) {
                            var mid = Math.floor(chunk.length / 2);
                            await this.transferDirs(chunk.slice(0, mid), targetPath);
                            await this.transferDirs(chunk.slice(mid), targetPath);
                        } else {
                            var dir = chunk[0];
                            var dirPath = this.shareRoot;
                            if (targetPath.length > this.rootPath.length) {
                                dirPath += targetPath.slice(this.rootPath.length);
                            }
                            dirPath += '/' + dir.name;
                            var subFiles = await this.listShareDir(this.userId, this.shareId, dirPath);
                            var subDirList = subFiles.filter(function (file) { return file.isDirectory; });
                            var subFileList = subFiles.filter(function (file) { return !file.isDirectory; });
                            this.totalFiles += subDirList.length + subFileList.length;
                            if (subDirList.length > 0) {
                                await this.transferDirs(subDirList, targetPath + '/' + dir.name);
                            }
                            if (subFileList.length > 0) {
                                await this.transferFiles(subFileList, targetPath + '/' + dir.name);
                            }
                        }
                    } else {
                        if (retryCount < this.maxRetries && !this.cancel) {
                            if (this.onLog) this.onLog(`⏳ 文件夹转存失败，重试 (${retryCount+1}/${this.maxRetries})`);
                            await new Promise(resolve => setTimeout(resolve, 10000));
                            return await this.transferDirs(dirList, targetPath, retryCount + 1);
                        } else {
                            throw error;
                        }
                    }
                }
            }
        },

        listShareDir: async function (userId, shareId, dirPath, retryCount = 0) {
            var path = "/share/list";
            var page = 1;
            var limit = 100;
            var result = [];
            try {
                while (true) {
                    var params = `uk=${userId}&shareid=${shareId}&order=name&desc=0&showempty=0&page=${page}&num=100&dir=${this.customUrlEncode(dirPath)}`;
                    var response = await this.request(path, "GET", params, null, true);
                    var list = response.list;
                    list.forEach(function (item) {
                        result.push({
                            id: item.fs_id,
                            name: item.server_filename,
                            isDirectory: item.isdir === 1
                        });
                    });
                    if (list.length < 100) {
                        break;
                    }
                    page++;
                }
                return result;
            } catch (error) {
                if (retryCount < this.maxRetries) {
                    if (this.onLog) this.onLog(`⏳ 列表获取失败，重试 (${retryCount+1}/${this.maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    return await this.listShareDir(userId, shareId, dirPath, retryCount + 1);
                } else {
                    throw error;
                }
            }
        },

        // ===== 修复：提取分享 Key 时过滤 # 号 =====
        extractShareKey: function (url) {
            try {
                // 先去掉 # 号后面的内容
                var cleanUrl = url.split('#')[0];
                var decodedUrl = decodeURIComponent(cleanUrl);
                if (decodedUrl.includes("/s/1")) {
                    return decodedUrl.split("/s/1")[1].split("?")[0];
                } else if (decodedUrl.includes("surl=")) {
                    return decodedUrl.split("surl=")[1].split("&")[0];
                }
            } catch (e) {
                console.error("Error extracting share key:", e);
            }
            return null;
        },

        customUrlEncode: function (input) {
            let encoded = '';
            for (let c of input) {
                if (c === ' ' || c === '"' || c === '\'') {
                    encoded += encodeURIComponent(c);
                } else if (c === '+') {
                    encoded += '%2B';
                } else {
                    encoded += c;
                }
            }
            return encoded;
        },

        transferFinal: async function (url, pwd) {
            var shareKey = this.extractShareKey(url);
            if (!shareKey) {
                throw new Error("Unable to extract share key from URL");
            }
            await this.initShareData(shareKey, pwd);
            this.transferredFiles = 0;
            if (this.dirList.length > 0) {
                await this.transferDirs(this.dirList, this.rootPath);
            }
            if (this.fileList.length > 0) {
                await this.transferFiles(this.fileList, this.rootPath);
            }
        }
    };

    // ================================================================
    // 2. UI 控制面板
    // ================================================================

    const STATE = {
        IDLE: 'idle',
        RUNNING: 'running',
        COMPLETED: 'completed',
        ERROR: 'error',
        STOPPED: 'stopped'
    };

    let appState = {
        status: STATE.IDLE,
        totalFiles: 0,
        transferredFiles: 0,
        currentBatch: 0,
        totalBatches: 0,
        errorMessage: '',
        logMessages: [],
    };

    let transferInstance = null;

    function saveMemory(pwd, path) {
        if (pwd) GM_setValue('saved_pwd', pwd);
        if (path) GM_setValue('saved_path', path);
    }

    function loadMemory() {
        return {
            pwd: GM_getValue('saved_pwd', ''),
            path: GM_getValue('saved_path', '')
        };
    }

    function getDefaultPath() {
        const now = new Date();
        const dateStr = now.getFullYear() + '-' +
                       String(now.getMonth() + 1).padStart(2, '0') + '-' +
                       String(now.getDate()).padStart(2, '0');
        return `/转存_${dateStr}`;
    }

    function addLog(message, type = 'info') {
        const time = new Date().toLocaleTimeString();
        appState.logMessages.unshift({ time, message, type });
        if (appState.logMessages.length > 200) {
            appState.logMessages.pop();
        }
        updateUI();
        console.log('[转存助手]', message);
    }

    function updateUI() {
        const totalEl = document.getElementById('stat-total');
        const transferredEl = document.getElementById('stat-transferred');
        const batchEl = document.getElementById('stat-batch');
        const progressFill = document.getElementById('progress-fill');
        const progressPercent = document.getElementById('progress-percent');
        const statusBadge = document.getElementById('status-badge');
        const statusText = document.getElementById('status-text');
        const startBtn = document.getElementById('btn-start');
        const stopBtn = document.getElementById('btn-stop');
        const logContent = document.getElementById('log-content');

        if (totalEl) totalEl.textContent = appState.totalFiles || 0;
        if (transferredEl) transferredEl.textContent = appState.transferredFiles || 0;
        if (batchEl) batchEl.textContent = `${appState.currentBatch || 0}/${appState.totalBatches || 0}`;

        const progress = appState.totalFiles > 0 ? (appState.transferredFiles / appState.totalFiles * 100) : 0;
        if (progressFill) progressFill.style.width = progress.toFixed(1) + '%';
        if (progressPercent) progressPercent.textContent = progress.toFixed(1) + '%';

        const statusMap = {
            [STATE.IDLE]: { text: '就绪', class: 'status-idle' },
            [STATE.RUNNING]: { text: '运行中', class: 'status-running' },
            [STATE.COMPLETED]: { text: '✅ 已完成', class: 'status-completed' },
            [STATE.ERROR]: { text: '❌ 错误', class: 'status-error' },
            [STATE.STOPPED]: { text: '⏹ 已停止', class: 'status-idle' },
        };
        const info = statusMap[appState.status] || statusMap[STATE.IDLE];
        if (statusBadge) {
            statusBadge.textContent = info.text;
            statusBadge.className = 'status-badge ' + info.class;
        }
        if (statusText) {
            statusText.textContent = appState.errorMessage || '';
        }

        if (startBtn && stopBtn) {
            if (appState.status === STATE.IDLE || appState.status === STATE.COMPLETED || appState.status === STATE.ERROR || appState.status === STATE.STOPPED) {
                startBtn.style.display = 'inline-block';
                stopBtn.style.display = 'none';
                startBtn.textContent = appState.status === STATE.COMPLETED ? '🔄 重新开始' : '▶ 开始转存';
                startBtn.disabled = false;
            } else if (appState.status === STATE.RUNNING) {
                startBtn.style.display = 'none';
                stopBtn.style.display = 'inline-block';
                stopBtn.disabled = false;
            }
        }

        if (logContent) {
            logContent.innerHTML = appState.logMessages.map(log => {
                const cls = log.type === 'error' ? 'log-error' :
                            log.type === 'success' ? 'log-success' :
                            log.type === 'warning' ? 'log-warning' : 'log-info';
                return `<div class="log-item ${cls}"><span class="log-time">[${log.time}]</span> ${log.message}</div>`;
            }).join('');
            logContent.scrollTop = 0;
        }
    }

    async function startTransfer(url, pwd, targetPath) {
        if (appState.status === STATE.RUNNING) return;

        // 如果目标路径为空，自动生成日期文件夹
        if (!targetPath || targetPath.trim() === '') {
            targetPath = getDefaultPath();
            document.getElementById('input-path').value = targetPath;
            addLog(`📁 未指定路径，自动创建：${targetPath}`, 'info');
        }

        saveMemory(pwd, targetPath);

        appState.status = STATE.RUNNING;
        appState.errorMessage = '';
        appState.transferredFiles = 0;
        appState.totalFiles = 0;
        appState.currentBatch = 0;
        appState.totalBatches = 0;
        updateUI();

        try {
            transferInstance = new BaiduTransfer(targetPath || '');
            transferInstance.maxRetries = 5;
            transferInstance.cancel = false;

            transferInstance.onLog = function(msg) {
                addLog(msg, 'info');
            };
            transferInstance.onProgress = function(transferred, total) {
                appState.transferredFiles = transferred;
                appState.totalFiles = total;
                const batchSize = 100;
                appState.totalBatches = Math.ceil(total / batchSize);
                appState.currentBatch = Math.ceil(transferred / batchSize) || 0;
                if (appState.currentBatch > appState.totalBatches) {
                    appState.currentBatch = appState.totalBatches;
                }
                updateUI();
            };

            addLog(`开始转存：${url}`, 'info');
            if (pwd) addLog(`提取码：${pwd}`, 'info');
            addLog(`目标路径：${targetPath}`, 'info');

            await transferInstance.transferFinal(url, pwd);

            if (transferInstance.cancel) {
                appState.status = STATE.STOPPED;
                addLog('⏹ 转存已停止', 'warning');
            } else {
                // 轻量版不做统计和核验；转存 API 全部成功返回后，直接把进度条收口到 100%。
                appState.totalFiles = Math.max(appState.totalFiles || 0, transferInstance.totalFiles || 0, appState.transferredFiles || 0);
                appState.transferredFiles = appState.totalFiles;
                appState.status = STATE.COMPLETED;
                addLog(`🎉 全部转存完成！共 ${appState.transferredFiles} 个文件/文件夹`, 'success');
                playBeep();
                GM_notification({
                    title: '转存完成',
                    text: `成功转存 ${appState.transferredFiles} 个文件/文件夹`,
                    timeout: 5000,
                });
            }
            updateUI();
        } catch (error) {
            if (error.message === '操作已取消') {
                appState.status = STATE.STOPPED;
                addLog('⏹ 已安全停止', 'warning');
            } else {
                appState.status = STATE.ERROR;
                appState.errorMessage = error.message || '未知错误';
                addLog(`❌ 转存失败：${error.message}`, 'error');
                playBeep();
            }
            updateUI();
        } finally {
            transferInstance = null;
            if (appState.status !== STATE.COMPLETED && appState.status !== STATE.ERROR && appState.status !== STATE.STOPPED) {
                appState.status = STATE.IDLE;
                updateUI();
            }
        }
    }

    function stopTransfer() {
        if (transferInstance) {
            transferInstance.cancel = true;
            addLog('正在停止...', 'warning');
        }
    }

    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'transfer-helper-panel';
        panel.innerHTML = `
            <div class="panel-header">
                <span class="panel-title">📦 转存助手 by Qi</span>
                <button class="panel-toggle" title="折叠/展开">—</button>
            </div>
            <div class="panel-body">
                <div class="feedback-tip">问题反馈：QQ 544439919</div>
                <div class="input-section">
                    <input type="text" id="input-url" placeholder="分享链接（自动识别当前页）" style="width:100%; padding:8px; margin-bottom:6px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
                    <div style="display:flex; gap:6px;">
                        <input type="text" id="input-pwd" placeholder="提取码（自动识别 + 记忆）" style="flex:1; padding:8px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
                        <input type="text" id="input-path" placeholder="目标路径（留空自动建日期文件夹）" style="flex:2; padding:8px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
                    </div>
                </div>

                <div class="stats-row">
                    <div class="stat-item"><span class="stat-label">📄 总文件</span><span class="stat-value" id="stat-total">0</span></div>
                    <div class="stat-item"><span class="stat-label">✅ 已转存</span><span class="stat-value" id="stat-transferred">0</span></div>
                    <div class="stat-item"><span class="stat-label">📦 批次</span><span class="stat-value" id="stat-batch">0/0</span></div>
                </div>

                <div class="progress-section">
                    <div class="progress-header"><span>总进度</span><span id="progress-percent">0%</span></div>
                    <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
                </div>

                <div class="status-section">
                    <span class="status-badge" id="status-badge">就绪</span>
                    <span class="status-text" id="status-text"></span>
                </div>

                <div class="control-buttons">
                    <button class="btn btn-primary" id="btn-start">▶ 开始转存</button>
                    <button class="btn btn-danger" id="btn-stop" style="display:none;">⏹ 停止</button>
                </div>

                <div class="log-section">
                    <div class="log-header"><span>运行日志</span><button class="btn-clear" id="btn-clear-log">清空</button></div>
                    <div class="log-content" id="log-content"></div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        // ===== 修复：自动识别链接时，过滤掉 # 号后面的内容 =====
        const urlInput = document.getElementById('input-url');
        const pwdInput = document.getElementById('input-pwd');
        const pathInput = document.getElementById('input-path');
        const currentUrl = window.location.href.split('#')[0];  // 🔧 去掉 # 号

        if (currentUrl.includes('/s/')) {
            urlInput.value = currentUrl;
            const pwdMatch = currentUrl.match(/[?&]pwd=([^&]+)/);
            if (pwdMatch) pwdInput.value = pwdMatch[1];
        }

        const memory = loadMemory();
        if (memory.pwd && !pwdInput.value) {
            pwdInput.value = memory.pwd;
        }
        if (memory.path) {
            pathInput.value = memory.path;
        } else {
            pathInput.placeholder = `留空自动建: ${getDefaultPath()}`;
        }

        setupPanelEvents(panel);
        setupPanelDrag(panel);
        updateUI();
    }

    function setupPanelEvents(panel) {
        const startBtn = document.getElementById('btn-start');
        const stopBtn = document.getElementById('btn-stop');
        const clearBtn = document.getElementById('btn-clear-log');
        const toggleBtn = panel.querySelector('.panel-toggle');

        toggleBtn.addEventListener('click', () => {
            const body = panel.querySelector('.panel-body');
            body.style.display = body.style.display === 'none' ? 'block' : 'none';
            toggleBtn.textContent = body.style.display === 'none' ? '+' : '—';
        });

        startBtn.addEventListener('click', async () => {
            const url = document.getElementById('input-url').value.trim();
            const pwd = document.getElementById('input-pwd').value.trim();
            const path = document.getElementById('input-path').value.trim();
            if (!url) { alert('请输入分享链接'); return; }
            await startTransfer(url, pwd, path);
        });

        stopBtn.addEventListener('click', () => {
            if (confirm('确定要停止转存吗？')) {
                stopTransfer();
            }
        });

        clearBtn.addEventListener('click', () => {
            appState.logMessages = [];
            updateUI();
        });
    }

    function setupPanelDrag(panel) {
        const header = panel.querySelector('.panel-header');
        let isDragging = false, startX, startY, startLeft, startTop;
        header.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('panel-toggle')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startLeft = panel.offsetLeft;
            startTop = panel.offsetTop;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            panel.style.left = Math.max(0, startLeft + e.clientX - startX) + 'px';
            panel.style.top = Math.max(0, startTop + e.clientY - startY) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { isDragging = false; });
    }

    function addStyles() {
        GM_addStyle(`
            #transfer-helper-panel {
                position: fixed;
                top: 20px;
                right: 20px;
                width: 420px;
                max-height: 88vh;
                background: #fff;
                border-radius: 10px;
                box-shadow: 0 6px 28px rgba(0,0,0,0.25);
                z-index: 99999;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                font-size: 14px;
                color: #333;
                overflow: hidden;
                border: 1px solid rgba(0,0,0,0.08);
            }
            #transfer-helper-panel .panel-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                cursor: move;
                user-select: none;
                font-size: 16px;
            }
            #transfer-helper-panel .panel-title { font-weight: 600; letter-spacing: 0.3px; }
            #transfer-helper-panel .panel-toggle {
                background: none; border: none; color: white; font-size: 20px; cursor: pointer;
                padding: 0 5px; line-height: 1; opacity: 0.8;
            }
            #transfer-helper-panel .panel-toggle:hover { opacity: 1; }
            #transfer-helper-panel .panel-body {
                padding: 14px;
                overflow-y: auto;
                max-height: calc(88vh - 48px);
            }
            #transfer-helper-panel .input-section { margin-bottom: 12px; }
            #transfer-helper-panel .feedback-tip {
                margin-bottom: 10px;
                padding: 7px 10px;
                background: #f6f4ff;
                border: 1px solid #e5ddff;
                border-radius: 6px;
                color: #6b52c8;
                font-size: 13px;
                font-weight: 500;
                text-align: center;
            }
            #transfer-helper-panel .input-section input {
                font-size: 14px !important;
            }
            #transfer-helper-panel .stats-row {
                display: grid;
                grid-template-columns: 1fr 1fr 1fr;
                gap: 6px;
                margin-bottom: 12px;
                background: #f8f9fa;
                border-radius: 6px;
                padding: 10px 6px;
            }
            #transfer-helper-panel .stat-item { text-align: center; }
            #transfer-helper-panel .stat-label {
                display: block;
                color: #999;
                font-size: 13px;
                margin-bottom: 2px;
            }
            #transfer-helper-panel .stat-value {
                display: block;
                font-size: 20px;
                font-weight: 700;
                color: #333;
            }
            #transfer-helper-panel .progress-section { margin-bottom: 8px; }
            #transfer-helper-panel .progress-header {
                display: flex; justify-content: space-between; margin-bottom: 4px;
                font-size: 13px; color: #666;
            }
            #transfer-helper-panel .progress-bar {
                height: 10px;
                background: #e8e8e8;
                border-radius: 5px;
                overflow: hidden;
            }
            #transfer-helper-panel .progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
                border-radius: 5px;
                transition: width 0.3s ease;
                width: 0%;
            }
            #transfer-helper-panel .status-section {
                display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
            }
            #transfer-helper-panel .status-badge {
                padding: 4px 14px;
                border-radius: 14px;
                font-size: 13px;
                font-weight: 500;
                white-space: nowrap;
            }
            #transfer-helper-panel .status-badge.status-idle { background: #e8e8e8; color: #666; }
            #transfer-helper-panel .status-badge.status-running { background: #e6f7ff; color: #1890ff; }
            #transfer-helper-panel .status-badge.status-completed { background: #f6ffed; color: #52c41a; }
            #transfer-helper-panel .status-badge.status-error { background: #fff2f0; color: #ff4d4f; }
            #transfer-helper-panel .status-text {
                font-size: 13px;
                color: #ff4d4f;
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            #transfer-helper-panel .control-buttons {
                display: flex; gap: 8px; margin-bottom: 10px;
            }
            #transfer-helper-panel .btn {
                flex: 1; padding: 10px 16px; border: none; border-radius: 6px;
                cursor: pointer; font-size: 15px; font-weight: 600;
                transition: all 0.2s;
            }
            #transfer-helper-panel .btn:hover { opacity: 0.85; transform: translateY(-1px); }
            #transfer-helper-panel .btn:active { transform: scale(0.97); }
            #transfer-helper-panel .btn-primary {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
            }
            #transfer-helper-panel .btn-danger {
                background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
                color: white;
            }
            #transfer-helper-panel .log-section { margin-top: 10px; }
            #transfer-helper-panel .log-header {
                display: flex; justify-content: space-between; align-items: center;
                margin-bottom: 6px; font-size: 13px; color: #666;
            }
            #transfer-helper-panel .btn-clear {
                background: none; border: none; color: #bbb; cursor: pointer; font-size: 13px; padding: 0;
            }
            #transfer-helper-panel .btn-clear:hover { color: #666; }
            #transfer-helper-panel .log-content {
                height: 220px;
                overflow-y: auto;
                background: #fafafa;
                border-radius: 6px;
                padding: 8px 10px;
                font-size: 13px;
                font-family: Consolas, Monaco, monospace;
                border: 1px solid #eee;
            }
            #transfer-helper-panel .log-item { margin-bottom: 4px; line-height: 1.6; word-break: break-all; }
            #transfer-helper-panel .log-time { color: #aaa; margin-right: 8px; }
            #transfer-helper-panel .log-info { color: #333; }
            #transfer-helper-panel .log-success { color: #52c41a; }
            #transfer-helper-panel .log-warning { color: #fa8c16; }
            #transfer-helper-panel .log-error { color: #ff4d4f; }
            #transfer-helper-panel .log-content::-webkit-scrollbar {
                width: 8px;
            }
            #transfer-helper-panel .log-content::-webkit-scrollbar-track {
                background: #f0f0f0;
                border-radius: 4px;
            }
            #transfer-helper-panel .log-content::-webkit-scrollbar-thumb {
                background: #ccc;
                border-radius: 4px;
            }
            #transfer-helper-panel .log-content::-webkit-scrollbar-thumb:hover {
                background: #aaa;
            }
            #transfer-helper-panel ::-webkit-scrollbar { width: 6px; }
            #transfer-helper-panel ::-webkit-scrollbar-track { background: #f5f5f5; border-radius: 3px; }
            #transfer-helper-panel ::-webkit-scrollbar-thumb { background: #ddd; border-radius: 3px; }
            #transfer-helper-panel ::-webkit-scrollbar-thumb:hover { background: #ccc; }
        `);
    }

    function init() {
        const url = window.location.href;
        if (!url.includes('pan.baidu.com') && !url.includes('yun.baidu.com')) {
            return;
        }
        addStyles();
        createPanel();
        addLog('📦 转存助手 by Qi 已加载', 'info');
        addLog('💡 自动记忆 + 日期文件夹 + 完成提示音', 'info');
        addLog('💬 问题反馈 QQ：544439919', 'info');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

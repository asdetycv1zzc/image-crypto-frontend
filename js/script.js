// script.js (Cleaned Version)

document.addEventListener('DOMContentLoaded', (event) => {
    const uploadButton = document.getElementById('uploadButton');
    if (uploadButton) uploadButton.disabled = true;
});


if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(registration => {
                console.log('ServiceWorker 注册成功，作用域为: ', registration.scope);
            })
            .catch(error => {
                console.log('ServiceWorker 注册失败: ', error);
            });
    });
}

(function () {
    'use strict';

    const MAX_WORKERS = navigator.hardwareConcurrency || 4;
    console.log(`初始化 ${MAX_WORKERS} 个 Worker...`);

    const workerPool = [];      // 存储我们的工人（Worker）对象和他们的状态
    const taskQueue = [];       // 等待被处理的图片任务队列
    let processedFiles = [];    // 存储处理完成的结果
    let isWorking = false;      // 一个标志，用于判断整个处理流程是否在进行中

// --- 2. Worker 池的初始化 ---

    for (let i = 0; i < MAX_WORKERS; i++) {
        const worker = new Worker('js/crypto-worker.js');

        // 为每个 worker 设置消息处理器
        worker.onmessage = (event) => {
            handleWorkerMessage(worker, event.data);
        };

        // 将 worker 及其状态存入池中
        // 初始时，所有 worker 都被认为是“忙碌”的，直到它们发回 'ready' 消息
        workerPool.push({worker: worker, isBusy: true});
    }

    function scheduleTasks() {
        // 使用一个循环来持续派发任务，直到无法再派发为止
        while (true) {
            // 如果没有待处理的任务，或者当前没有在工作，就直接返回
            if (taskQueue.length === 0 || !isWorking) {
                // 检查是否所有任务都完成了
                checkIfAllDone();
                return; // 退出循环和函数
            }

            // 寻找一个不忙的工人
            const freeWorkerWrapper = workerPool.find(w => !w.isBusy);
            if (!freeWorkerWrapper) {
                return; // 所有工人都在忙，退出循环和函数
            }

            // --- 以下是成功派发一个任务的逻辑 ---

            // 从队列头部取出一个任务
            const task = taskQueue.shift();

            // 将工人标记为“忙碌”
            freeWorkerWrapper.isBusy = true;

            // 在UI上更新卡片状态
            updateCardStatus(task.file.name, 'processing', '正在处理...', null);

            // 将任务发送给工人
            freeWorkerWrapper.worker.postMessage({
                fileName: task.file.name,
                fileBuffer: task.buffer
            }, [task.buffer]);

            // **核心修正**: 循环将继续，立即尝试为下一个任务寻找下一个空闲的工人。
        }
    }

    // --- 加密/解密核心逻辑 (现在只包含我们自己的函数) ---
    /**
     * 处理从任何一个 Worker 返回的消息。
     * @param {Worker} workerInstance - 发送消息的那个 Worker 实例。
     * @param {object} data - 从 Worker 发回的数据对象。
     */
    function handleWorkerMessage(worker, data) {
        // 找到这个 worker 在我们池中的包装对象
        const workerWrapper = workerPool.find(w => w.worker === worker);
        if (!workerWrapper) return;

        // A. 如果是 Worker 发来的“准备就绪”消息
        if (data.status === 'ready') {
            workerWrapper.isBusy = false; // Worker 准备好了，标记为空闲
            console.log("一个 Worker 已准备就绪。");
            // 尝试立即调度一个任务
            scheduleTasks();
            return;
        }

        // B. 如果是 Worker 失败的消息
        if (data.status === 'error') {
            console.error(`文件 "${data.originalFileName}" 处理失败:`, data.error);
            updateCardStatus(data.originalFileName, 'error', data.error, null);
        }

        // C. 如果是 Worker 成功完成任务的消息
        else if (data.status === 'done') {
            const {buffer, newFileName} = data.result;
            const imageBlob = new Blob([buffer], {type: 'image/png'});

            // 将成功的结果存起来
            processedFiles.push({name: newFileName, blob: imageBlob});

            // 更新UI卡片，显示成功和缩略图
            updateCardStatus(data.originalFileName, 'success', '处理成功', imageBlob);
        }

        // 无论成功或失败，这个 worker 的任务都结束了，将它标记为空闲
        workerWrapper.isBusy = false;

        // 任务完成后，立即尝试调度下一个任务
        scheduleTasks();
    }


// --- 5. 检查是否所有工作都已完成 ---

    /**
     * 当任务队列为空时调用此函数，检查是否可以结束整个流程。
     */
    function checkIfAllDone() {
        // 如果任务队列不为空，说明还有任务在等待分配，不能结束
        if (taskQueue.length > 0) {
            return;
        }

        // 检查是否所有工人现在都处于空闲状态
        const allWorkersFree = workerPool.every(w => !w.isBusy);

        // 只有当任务队列为空，并且所有工人也都空闲时，才意味着全部工作完成
        if (allWorkersFree) {
            isWorking = false; // 结束工作状态
            console.log("所有图片处理完成！");

            // 启用UI按钮
            uploadButton.disabled = false;
            if (processedFiles.length > 0) {
                downloadButton.disabled = false;
            }
        }
    }

    function isSupportedImage(fileName) {
        const supportedExtensions = ['.png', '.jpg', '.jpeg', '.bmp'];
        return supportedExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
    }

    /**
     * 使用 fflate 异步解压 ZIP 文件或直接处理支持的图片。
     * 这个函数会返回一个 Promise，以便与 async/await 流程无缝集成。
     * @param {File} file - 用户上传的单个文件。
     * @returns {Promise<File[]>} - 一个 Promise，最终会解析为一个包含所有图片文件的数组。
     */
    function expandAndFilterFile(file) {
        // 1. 如果文件本身就是支持的图片，直接将其包装在数组中返回。
        if (isSupportedImage(file.name)) {
            return Promise.resolve([file]);
        }

        // 2. 如果不是 ZIP 文件，则跳过。
        if (!file.name.toLowerCase().endsWith('.zip')) {
            console.log(`跳过不支持的文件类型: ${file.name}`);
            return Promise.resolve([]);
        }

        // 3. 对于 ZIP 文件，返回一个包裹了 fflate 异步操作的 Promise。
        return new Promise(async (resolve, reject) => {
            console.log(`检测到 ZIP 文件: ${file.name}，使用 fflate 异步解压...`);

            try {
                // 首先，将文件读取为 fflate 需要的 Uint8Array 格式。
                // 这个操作本身是异步的，所以 Promise 的执行器需要标记为 async。
                const buffer = await file.arrayBuffer();
                const u8 = new Uint8Array(buffer);

                // 调用 fflate.unzip。这是一个异步函数，它接受一个回调。
                // 它会在内部启动 Worker，执行解压，完成后调用我们的回调。
                fflate.unzip(u8, (err, unzipped) => {
                    // a. 如果解压过程出错，则 reject Promise。
                    if (err) {
                        console.error(`fflate 异步解压文件 ${file.name} 失败:`, err);
                        return reject(err);
                    }

                    // b. 如果解压成功，处理解压后的数据。
                    const imageFiles = [];
                    // 遍历解压出的所有文件条目
                    for (const relativePath in unzipped) {
                        // 确保是支持的图片，并且不是一个空目录
                        if (isSupportedImage(relativePath) && unzipped[relativePath].length > 0) {
                            const fileData = unzipped[relativePath]; // 这是 Uint8Array 数据
                            const newFileName = `${file.name}/${relativePath}`; // 创建唯一文件名

                            // 从解压出的数据创建新的 File 对象
                            const imageFile = new File([fileData], newFileName, {
                                // 尝试从扩展名推断 MIME 类型
                                type: `image/${relativePath.split('.').pop().toLowerCase()}`
                            });
                            imageFiles.push(imageFile);
                        }
                    }

                    console.log(`在 ${file.name} 中找到 ${imageFiles.length} 个图片文件。`);
                    // c. 用包含所有图片文件的数组来 resolve Promise。
                    resolve(imageFiles);
                });
            } catch (e) {
                // 这个 catch 主要捕获 file.arrayBuffer() 可能发生的错误。
                reject(e);
            }
        });
    }


    // --- 前端交互逻辑 ---
    const fileInput = document.getElementById('fileInput');
    const uploadButton = document.getElementById('uploadButton');
    const downloadButton = document.getElementById('downloadButton');
    const resultsGrid = document.getElementById('results');
    const dropZone = document.querySelector('.container');

    uploadButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (event) => {
        const files = event.target.files;
        if (files.length > 0) {
            handleFileUpload(Array.from(files));
        }
    });
    downloadButton.addEventListener('click', handleDownload);
    dropZone.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // [新增] 添加视觉反馈
        dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', (event) => {
        event.preventDefault();
        event.stopPropagation();
        dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // 移除视觉反馈
        dropZone.classList.remove('drag-over');

        // 从事件中获取文件
        const files = event.dataTransfer.files;

        if (files.length > 0) {
            // 直接调用您现有的文件处理函数
            handleFileUpload(Array.from(files));
        }
    });

    // [新增] 用于下载单个文件的辅助函数
    function downloadFile(blob, fileName) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        // 短暂延迟后释放 URL 对象，确保下载有时间开始
        setTimeout(() => URL.revokeObjectURL(link.href), 100);
    }

    /**
     * 处理文件上传的主函数，现在它只负责准备任务并启动调度器。
     * @param {File[]} files - 用户选择的文件列表。
     */
    async function handleFileUpload(files) {
        // 1. 重置UI和状态
        resultsGrid.innerHTML = '';
        processedFiles = [];
        taskQueue.length = 0; // 确保清空旧的任务
        isWorking = true;     // 开始工作！
        uploadButton.disabled = true;
        downloadButton.disabled = true;

        try {
            // 2. 扩展文件列表（处理ZIP等），这部分保持不变
            console.log("开始扩展文件列表...");
            const expansionPromises = files.map(expandAndFilterFile);
            const nestedFileArrays = await Promise.all(expansionPromises);
            const allImageFiles = nestedFileArrays.flat();
            console.log(`共找到 ${allImageFiles.length} 个需要处理的图片。`);

            if (allImageFiles.length === 0) {
                resultsGrid.innerHTML = '<p>未在您上传的文件或压缩包中找到支持的图片 (PNG, JPG, BMP)。</p>';
                isWorking = false; // 没有任务，直接结束
                uploadButton.disabled = false;
                return;
            }

            // 3. 将所有文件转换为任务，并放入队列
            for (const file of allImageFiles) {
                // 为每个文件预先创建UI卡片
                createResultCard(file.name);
                try {
                    // 将文件读取为 ArrayBuffer
                    const buffer = await file.arrayBuffer();
                    // 将任务（包含文件和其内容）推入队列
                    taskQueue.push({file: file, buffer: buffer});
                } catch (e) {
                    // 如果单个文件读取失败，直接更新其卡片状态
                    updateCardStatus(file.name, 'error', '文件读取失败', null);
                }
            }

            console.log(`已将 ${taskQueue.length} 个任务加入队列。`);

            // 4. 启动调度器
            // 此时，如果已经有 worker 准备好了，它们会立即开始处理任务
            scheduleTasks();

        } catch (error) {
            // 这个 catch 主要捕获文件扩展（例如 ZIP 解压）阶段发生的严重错误
            console.error("处理上传文件时发生严重错误:", error);
            resultsGrid.innerHTML = `<p class="status error">处理失败: ${error.message}</p>`;
            isWorking = false; // 发生严重错误，结束工作
            uploadButton.disabled = false;
        }
    }

    function createResultCard(fileName) {
        const card = document.createElement('div');
        card.className = 'result-card';
        card.id = `card-${fileName.replace(/[^a-zA-Z0-9]/g, '-')}`; // 创建一个合法 ID
        card.innerHTML = `
            <div class="thumbnail-container">
                <div class="spinner"></div>
            </div>
            <p>${fileName}</p>
            <div class="status-container"></div>
        `;
        resultsGrid.appendChild(card);
    }

    function updateCardStatus(fileName, status, message, blob) {
        const cardId = `card-${fileName.replace(/[^a-zA-Z0-9]/g, '-')}`;
        const card = document.getElementById(cardId);
        if (!card) return;

        const thumbnailContainer = card.querySelector('.thumbnail-container');
        const statusContainer = card.querySelector('.status-container');

        thumbnailContainer.innerHTML = '';
        statusContainer.innerHTML = '';

        if (status === 'success' && blob) {
            // 为 blob 创建一个可访问的 URL
            const imageUrl = URL.createObjectURL(blob);

            const img = document.createElement('img');
            img.src = imageUrl;
            thumbnailContainer.appendChild(img);

            const statusBadge = document.createElement('span');
            statusBadge.className = 'status success';
            statusBadge.textContent = message;
            statusContainer.appendChild(statusBadge);

            // --- 功能改进 ---
            // 1. 给卡片添加一个 'clickable' 类，以便用 CSS 设置样式
            card.classList.add('clickable');

            // 2. 给整个卡片添加点击事件监听器
            card.addEventListener('click', () => {
                // 在新的标签页中打开图片 URL
                window.open(imageUrl, '_blank');
            });
            // --- 结束改进 ---

        } else if (status === 'error') {
            thumbnailContainer.textContent = '❌';
            const statusBadge = document.createElement('span');
            statusBadge.className = 'status error';
            statusBadge.textContent = message;
            statusContainer.appendChild(statusBadge);

            // 确保处理失败的卡片没有 clickable 样式和事件
            card.classList.remove('clickable');
        }
    }

    // [新函数] 智能下载处理器
    async function handleDownload() {
        if (processedFiles.length === 0) return;
        downloadButton.disabled = true;

        // --- 1. 定义模拟参数 ---
        const ESTIMATED_SPEED_MB_PER_SEC = 200; // MB/s，根据您的观察设定，可以调整

        // --- 2. 获取并重置UI元素 ---
        const progressWrapper = document.getElementById('progress-wrapper');
        const progressBar = document.getElementById('zip-progress');
        const progressText = document.getElementById('progress-percentage');

        progressWrapper.style.display = 'block';
        progressBar.style.width = '0%';
        progressText.textContent = '0%';

        let progressInterval = null; // 用于存放我们的计时器ID

        try {
            // --- 3. 并行读取文件并计算总大小 ---
            console.log("并行读取所有文件并计算总大小...");
            const readPromises = processedFiles.map(file => file.blob.arrayBuffer());
            const buffers = await Promise.all(readPromises);

            const dataToZip = {};
            let totalSizeInBytes = 0;
            processedFiles.forEach((file, index) => {
                const buffer = buffers[index];
                dataToZip[file.name] = new Uint8Array(buffer);
                totalSizeInBytes += buffer.byteLength;
            });

            // --- 4. 启动真正的后台压缩任务 ---
            const zipPromise = new Promise((resolve, reject) => {
                fflate.zip(dataToZip, {level: 1}, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });

            // --- 5. 根据总大小和速度，启动模拟进度条 ---
            const totalSizeInMB = totalSizeInBytes / (1024 * 1024);
            const estimatedDurationInMs = (totalSizeInMB / ESTIMATED_SPEED_MB_PER_SEC) * 1000;
            const startTime = Date.now();

            progressInterval = setInterval(() => {
                const elapsedTime = Date.now() - startTime;
                let currentProgress = Math.min((elapsedTime / estimatedDurationInMs) * 100, 99);
                currentProgress = Math.floor(currentProgress); // 取整

                progressBar.style.width = currentProgress + '%';
                progressText.textContent = currentProgress + '%';

                if (elapsedTime >= estimatedDurationInMs) {
                    clearInterval(progressInterval); // 预估时间到，停止更新
                }
            }, 200); // 每200毫秒更新一次UI

            // --- 6. 等待真正的压缩任务完成 ---
            const zipData = await zipPromise;

            // --- 7. 任务完成，清理并显示最终结果 ---
            clearInterval(progressInterval); // 确保计时器被清除
            progressBar.style.transition = 'width 0.5s ease-in-out'; // 给最后一步一个更明显的动画
            progressBar.style.width = '100%';
            progressText.textContent = '100%';

            const zipBlob = new Blob([zipData], {type: 'application/zip'});

            // 稍微延迟一下再下载，让用户看到100%的状态
            setTimeout(() => {
                downloadFile(zipBlob, `processed-images-${Date.now()}.zip`);
            }, 500);

        } catch (error) {
            console.error("fflate 异步压缩或模拟进度失败:", error);
            alert("打包下载失败！");
        } finally {
            // 确保无论成功或失败，都能清理和重置UI
            clearInterval(progressInterval);
            // 稍微延迟一下再隐藏，避免100%一闪而过
            setTimeout(() => {
                downloadButton.disabled = false;
                progressWrapper.style.display = 'none';
                progressBar.style.transition = 'width 0.2s ease-out'; // 恢复默认过渡
            }, 500);
        }
    }
})();






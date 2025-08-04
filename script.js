// script.js (Cleaned Version)
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

    // --- 加密/解密核心逻辑 (现在只包含我们自己的函数) ---

    const MAGIC_PIXEL_PATTERN = [
        {r: 0xDE, g: 0xAD, b: 0xBE, a: 0xEF},
        {r: 0xCA, g: 0xFE, b: 0xBA, a: 0xBE},
        {r: 0xFE, g: 0xED, b: 0xDE, a: 0xED},
        {r: 0xDA, g: 0x7A, b: 0xB0, a: 0x55},
    ];
    const CHANNELS = 4;

    function generateMagicRow(width) {
        const magicRow = new Uint8Array(width * CHANNELS);
        for (let j = 0; j < width; j++) {
            const patternPixel = MAGIC_PIXEL_PATTERN[j % MAGIC_PIXEL_PATTERN.length];
            const offset = j * CHANNELS;
            magicRow[offset] = patternPixel.r;
            magicRow[offset + 1] = patternPixel.g;
            magicRow[offset + 2] = patternPixel.b;
            magicRow[offset + 3] = patternPixel.a;
        }
        return magicRow;
    }

    function areBuffersEqual(view1, view2) {
        // 传入的参数直接就是 Uint8Array 视图 (lastRow 和 expectedMagicRow)
        if (!view1 || !view2 || view1.length !== view2.length) {
            // [调试] 添加日志，看看长度是否匹配
            if (view1 && view2) {
                console.error(`Buffer 比较失败：长度不匹配。 view1.length=${view1.length}, view2.length=${view2.length}`);
            }
            return false;
        }

        // 直接逐字节比较视图内容
        for (let i = 0; i < view1.length; i++) {
            if (view1[i] !== view2[i]) {
                // [调试] 如果发现不匹配，打印出具体位置和值
                console.error(`Buffer 在索引 ${i} 处不匹配: view1[${i}]=${view1[i]}, view2[${i}]=${view2[i]}`);
                return false;
            }
        }

        // 如果循环完成都没有返回 false，说明它们是相等的
        return true;
    }

    function isEncrypted(pixelData, width, height) {
        if (height < 2) return false;
        const expectedMagicRow = generateMagicRow(width);
        const lastRowOffset = (height - 1) * width * CHANNELS;
        const lastRow = pixelData.subarray(lastRowOffset, lastRowOffset + width * CHANNELS);
        return areBuffersEqual(lastRow, expectedMagicRow);
    }

    function decodeImage(buffer) {
        const view = new Uint8Array(buffer);
        let type = 'UNKNOWN';
        if (view.length > 3 && view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4E && view[3] === 0x47) type = 'PNG';
        else if (view.length > 2 && view[0] === 0xFF && view[1] === 0xD8 && view[2] === 0xFF) type = 'JPG';
        else if (view.length > 1 && view[0] === 0x42 && view[1] === 0x4D) type = 'BMP';

        if (type === 'PNG') {
            // UPNG 是由 UPNG.js 创建的全局变量
            const img = UPNG.decode(buffer);
            return {width: img.width, height: img.height, data: new Uint8Array(UPNG.toRGBA8(img)[0])};
        }
        if (type === 'JPG') {
            // jpeg 是由 jpeg-decoder.js 创建的全局变量
            return jpeg.decode(view, {useTArray: true});
        }
        if (type === 'BMP') {
            // BmpDecoder 是由 bmp-decoder.js 创建的全局变量
            const decoder = new BmpDecoder(Buffer.from(view)); // bmp-js 需要一个 Buffer-like 对象
            return {width: decoder.width, height: decoder.height, data: decoder.getData()};
        }
        throw new Error(`不支持的图片格式 (${type}) 或文件已损坏。`);
    }

    function isSupportedImage(fileName) {
        const supportedExtensions = ['.png', '.jpg', '.jpeg', '.bmp'];
        return supportedExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
    }

    async function expandAndFilterFile(file) {
        // 如果文件本身不是 ZIP，但却是支持的图片，直接返回包含它自己的数组
        if (isSupportedImage(file.name)) {
            return [file];
        }

        // 如果文件是 ZIP，则尝试解压并提取所有支持的图片
        if (file.name.toLowerCase().endsWith('.zip')) {
            console.log(`检测到 ZIP 文件: ${file.name}，开始解压...`);
            const zip = await JSZip.loadAsync(file);
            const imageFilePromises = [];

            zip.forEach((relativePath, zipEntry) => {
                // 忽略文件夹，只处理文件
                if (!zipEntry.dir && isSupportedImage(zipEntry.name)) {
                    console.log(`在 ZIP 中找到图片: ${relativePath}`);
                    // 异步提取文件内容为 Blob
                    const promise = zipEntry.async('blob').then(blob => {
                        // 将 Blob 重新包装成一个 File 对象，保留其原始路径作为新文件名
                        // 这样即使用户上传了多个包含同名文件的 ZIP，我们也能区分
                        const newFileName = `${file.name}/${relativePath}`;
                        return new File([blob], newFileName, {type: blob.type});
                    });
                    imageFilePromises.push(promise);
                }
            });

            // 等待所有图片文件都提取完毕
            return Promise.all(imageFilePromises);
        }

        // 如果文件既不是支持的图片，也不是 ZIP，返回空数组表示跳过
        console.log(`跳过不支持的文件类型: ${file.name}`);
        return [];
    }

    // 图片处理的主函数
    // 在您的 script.js 中，找到并替换这个函数

    const BLOCK_SIZE = 16; // 定义块大小为 16x16 像素，可以调整
    const MAP_PIXEL_CHANNELS = 4; // 用一个 RGBA 像素来存一个 32 位整数的 map index

    /**
     * 将一个 32 位整数（块索引）编码到一个 RGBA 像素中。
     * @param {number} num - 要编码的数字.
     * @param {Uint8Array} pixelData - 目标像素数据 (长度为 4).
     * @param {number} offset - 在像素数据中的偏移量.
     */
    function encodeNumberToPixel(num, pixelData, offset) {
        pixelData[offset] = (num >> 24) & 0xFF; // Red
        pixelData[offset + 1] = (num >> 16) & 0xFF; // Green
        pixelData[offset + 2] = (num >> 8) & 0xFF; // Blue
        pixelData[offset + 3] = num & 0xFF;         // Alpha
    }

    /**
     * 将原始尺寸编码到密钥行中。
     * @param {Uint8Array} keyRow - 目标密钥行.
     * @param {number} width - 原始宽度.
     * @param {number} height - 原始高度.
     */
    function encodeDimensionsToKeyRow(keyRow, width, height) {
        // 使用 DataView 来方便地写入 32 位整数，无需手动位移
        const view = new DataView(keyRow.buffer);
        // 0-3 字节存储宽度
        view.setUint32(0, width, false); // false for big-endian
        // 4-7 字节存储高度
        view.setUint32(4, height, false); // false for big-endian
        // keyRow 的剩余部分可以填充随机数
        crypto.getRandomValues(keyRow.subarray(8));
    }

    /**
     * 从密钥行中解码出原始尺寸。
     * @param {Uint8Array} keyRow - 包含尺寸信息的密钥行.
     * @returns {{width: number, height: number}} - 解码出的尺寸.
     */
    function decodeDimensionsFromKeyRow(keyRow) {
        const view = new DataView(keyRow.buffer);
        const width = view.getUint32(0, false);
        const height = view.getUint32(4, false);
        return {width, height};
    }

    /**
     * 从一个 RGBA 像素中解码出 32 位整数。
     * @param {Uint8Array} pixelData - 包含像素数据的数组.
     * @param {number} offset - 像素的起始偏移量.
     * @returns {number} 解码后的数字.
     */
    function decodeNumberFromPixel(pixelData, offset) {
        const r = pixelData[offset];
        const g = pixelData[offset + 1];
        const b = pixelData[offset + 2];
        const a = pixelData[offset + 3];
        return (r << 24) | (g << 16) | (b << 8) | a;
    }

    /**
     * Fisher-Yates (aka Knuth) Shuffle 算法，用于随机打乱数组。
     * @param {Array} array - 需要打乱的数组.
     */
    function shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    /**
     * 将一个块从源数据复制到目标数据，能安全处理边缘不完整的块。
     * @param {Uint8Array} src - 源像素数据 (完整缓冲区).
     * @param {number} srcWidth - 源图像的完整宽度.
     * @param {number} srcHeight - 源图像内容区域的高度.
     * @param {number} srcStartRow - 源内容在缓冲区中的起始行.
     * @param {Uint8Array} dest - 目标像素数据 (完整缓冲区).
     * @param {number} destWidth - 目标图像的完整宽度.
     * @param {number} destHeight - 目标内容区域的高度.
     * @param {number} destStartRow - 目标内容在缓冲区中的起始行.
     * @param {number} destBlockX - 目标位置块的 X 坐标.
     * @param {number} destBlockY - 目标位置块的 Y 坐标.
     * @param {number} srcBlockX - 源位置块的 X 坐标.
     * @param {number} srcBlockY - 源位置块的 Y 坐标.
     */
    function copyBlock(src, srcWidth, srcHeight, srcStartRow, dest, destWidth, destHeight, destStartRow, destBlockX, destBlockY, srcBlockX, srcBlockY) {
        const srcStartX = srcBlockX * BLOCK_SIZE;
        const srcStartY = srcBlockY * BLOCK_SIZE;
        const destStartX = destBlockX * BLOCK_SIZE;
        const destStartY = destBlockY * BLOCK_SIZE;

        // --- 核心改动：分别计算源和目标的有效尺寸 ---
        const effectiveBlockWidth = Math.min(BLOCK_SIZE, srcWidth - srcStartX);
        const effectiveBlockHeight = Math.min(BLOCK_SIZE, srcHeight - srcStartY);

        // 确保目标块的Y坐标没有超出目标区域的高度
        if (destStartY >= destHeight) {
            return; // 这个块在目标区域之外，直接跳过
        }

        for (let y = 0; y < effectiveBlockHeight; y++) {
            // 检查当前行是否会超出源或目标的高度限制
            if ((srcStartY + y >= srcHeight) || (destStartY + y >= destHeight)) {
                continue;
            }

            const srcFinalRow = srcStartY + y + srcStartRow;
            const destFinalRow = destStartY + y + destStartRow;

            const srcOffset = (srcFinalRow * srcWidth + srcStartX) * CHANNELS;
            const destOffset = (destFinalRow * destWidth + destStartX) * CHANNELS;

            const bytesToCopy = effectiveBlockWidth * CHANNELS;

            // --- 最后的防线：在 .set() 之前进行最终检查 ---
            if (destOffset + bytesToCopy > dest.length) {
                console.error(`越界错误预防：试图写入到 ${destOffset + bytesToCopy}，但缓冲区长度为 ${dest.length}。`);
                continue; // 跳过这个写入操作
            }

            const rowData = src.subarray(srcOffset, srcOffset + bytesToCopy);
            dest.set(rowData, destOffset);
        }
    }


    async function encryptWithShuffle(pixels, width, height) {
        console.log("执行 Index-Shuffle 加密流程...");

        const blocksX = Math.ceil(width / BLOCK_SIZE);
        const blocksY = Math.ceil(height / BLOCK_SIZE);
        const totalBlocks = blocksX * blocksY;

        const shuffleMap = Array.from({ length: totalBlocks }, (_, i) => i);
        shuffleArray(shuffleMap);

        const mapRows = Math.ceil(totalBlocks / width);
        const newHeight = mapRows + height + 2;
        const outputPixels = new Uint8Array(width * newHeight * CHANNELS);

        // 1. 将 Shuffle Map 写入
        for(let i=0; i<totalBlocks; i++){
            encodeNumberToPixel(shuffleMap[i], outputPixels, i * CHANNELS);
        }

        // 2. 创建 keyRow 并将原始尺寸编码进去
        const keyRowOffset = mapRows * width * CHANNELS;
        const keyRow = outputPixels.subarray(keyRowOffset, keyRowOffset + width * CHANNELS);
        encodeDimensionsToKeyRow(keyRow, width, height);

        // 3. 复制图像数据
        const imageContentStartRow = mapRows + 1;
        for (let i = 0; i < totalBlocks; i++) {
            const originalBlockIndex = shuffleMap[i];
            const srcBlockX = originalBlockIndex % blocksX;
            const srcBlockY = Math.floor(originalBlockIndex / blocksX);
            const destBlockX = i % blocksX;
            const destBlockY = Math.floor(i / blocksX);

            copyBlock(
                pixels, width, height, 0,
                outputPixels, width, height, imageContentStartRow,
                destBlockX, destBlockY, srcBlockX, srcBlockY
            );
        }

        // 4. 在末尾添加 Magic Row
        const magicRow = generateMagicRow(width);
        outputPixels.set(magicRow, (newHeight - 1) * width * CHANNELS);

        console.log("Shuffle 加密完成。");
        return UPNG.encode([outputPixels.buffer], width, newHeight, 0);
    }

    /**
     * 通过迭代反向计算，从加密后的高度精确求解出原始高度。
     * @param {number} encryptedHeight - 加密后的图片总高度.
     * @param {number} width - 图片宽度.
     * @returns {number} - 原始图片的高度，如果无解则返回 -1.
     */
    function solveOriginalHeight(encryptedHeight, width) {
        const blocksX = Math.ceil(width / BLOCK_SIZE);

        // 我们从可能的最高原始高度开始向下迭代
        // 原始高度至少比加密高度小3 (1 for map, 1 for key, 1 for magic)
        for (let h_orig = encryptedHeight - 3; h_orig > 0; h_orig--) {
            const blocksY = Math.ceil(h_orig / BLOCK_SIZE);
            const totalBlocks = blocksX * blocksY;
            const mapPixels = totalBlocks;
            const mapRows = Math.ceil(mapPixels / width);

            // 检查这个假设的原始高度是否满足我们的方程
            if (encryptedHeight === h_orig + mapRows + 2) {
                // 找到了唯一解！
                return h_orig;
            }
        }

        // 如果循环结束还没找到，说明文件格式有问题
        return -1;
    }


    async function decryptWithShuffle(pixels, width, height) {
        console.log("执行 Index-Shuffle 解密流程...");

        // 1. 临时计算 mapRows 来定位 keyRow
        // 这个计算是临时的，并且可能不精确，但足以帮我们找到 keyRow 的大致位置
        const tempBlocksX = Math.ceil(width / BLOCK_SIZE);
        const tempBlocksY = Math.ceil((height - 2) / BLOCK_SIZE); // 减去 key/magic
        const tempTotalBlocks = tempBlocksX * tempBlocksY;
        let mapRows = Math.ceil(tempTotalBlocks / width);

        // 2. 从 keyRow 精确解码原始尺寸
        const keyRowOffset = mapRows * width * CHANNELS;
        const keyRow = pixels.subarray(keyRowOffset, keyRowOffset + width * CHANNELS);
        const { width: originalWidth, height: originalHeight } = decodeDimensionsFromKeyRow(keyRow);

        // 安全校验
        if (originalWidth !== width) {
            throw new Error(`解密失败：宽度不匹配！文件宽度 ${width}, 存储宽度 ${originalWidth}`);
        }
        if (originalHeight <= 0 || originalHeight > height) {
            throw new Error(`解密失败：解码出的高度 ${originalHeight} 无效。`);
        }
        console.log(`从密钥行成功解码出原始尺寸: ${originalWidth}x${originalHeight}`);

        // 3. 使用 100% 准确的尺寸，重新计算所有参数
        const blocksX = Math.ceil(originalWidth / BLOCK_SIZE);
        const blocksY = Math.ceil(originalHeight / BLOCK_SIZE);
        const totalBlocks = blocksX * blocksY;
        mapRows = Math.ceil(totalBlocks / originalWidth); // 覆盖掉临时的 mapRows

        // 4. 读取 Shuffle Map
        const shuffleMap = new Array(totalBlocks);
        for (let i = 0; i < totalBlocks; i++) {
            shuffleMap[i] = decodeNumberFromPixel(pixels, i * CHANNELS);
        }

        // 5. 恢复图像
        const decryptedPixels = new Uint8Array(originalWidth * originalHeight * CHANNELS);
        const encryptedContentStartRow = mapRows + 1;

        for (let i = 0; i < totalBlocks; i++) {
            const originalBlockIndex = shuffleMap[i];
            const destBlockX = originalBlockIndex % blocksX;
            const destBlockY = Math.floor(originalBlockIndex / blocksX);
            const srcBlockX = i % blocksX;
            const srcBlockY = Math.floor(i / blocksX);

            copyBlock(
                pixels, originalWidth, originalHeight, encryptedContentStartRow,
                decryptedPixels, originalWidth, originalHeight, 0,
                destBlockX, destBlockY, srcBlockX, srcBlockY
            );
        }

        console.log("Shuffle 解密完成。");
        return UPNG.encode([decryptedPixels.buffer], originalWidth, originalHeight, 0);
    }

    async function processImageFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    console.log(`--- 开始处理文件: ${file.name} ---`);
                    const buffer = event.target.result;
                    const {width, height, data: pixels} = decodeImage(buffer);

                    if (!width || !height || !pixels || pixels.length === 0) {
                        throw new Error("解码失败，无法获取图片数据。");
                    }

                    console.log(`解码后尺寸: ${width}x${height}`);

                    const isAlreadyEncrypted = isEncrypted(pixels, width, height);
                    console.log(`isEncrypted 函数返回: ${isAlreadyEncrypted}`);

                    let outputPngBuffer;

                    if (isAlreadyEncrypted) {
                        // 如果检测到 magic row，使用新的 shuffle 解密器
                        outputPngBuffer = await decryptWithShuffle(pixels, width, height);
                    } else {
                        // 否则，使用新的 shuffle 加密器
                        outputPngBuffer = await encryptWithShuffle(pixels, width, height);
                    }

                    const imageBlob = new Blob([outputPngBuffer], {type: 'image/png'});
                    const newFileName = isAlreadyEncrypted ? `decrypted-shuffled-${file.name.replace(/\.png$/i, '')}` : `encrypted-shuffled-${file.name.split('.').slice(0, -1).join('.') || file.name}.png`;

                    resolve({name: newFileName, blob: imageBlob});
                } catch (error) {
                    console.error("处理图片时发生错误:", error);
                    // 提供更具体的错误信息给卡片
                    const errorMessage = error.message || "未知错误";
                    reject(new Error(`处理失败: ${errorMessage}`));
                }
            };
            reader.onerror = (error) => reject(new Error("文件读取失败。"));
            reader.readAsArrayBuffer(file);
        });
    }

    // --- 前端交互逻辑 ---
    const fileInput = document.getElementById('fileInput');
    const uploadButton = document.getElementById('uploadButton');
    const downloadButton = document.getElementById('downloadButton');
    const resultsGrid = document.getElementById('results');
    const dropZone = document.querySelector('.container');
    let processedFiles = [];

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

    function isMobileDevice() {
        // 一个简单但相当有效的正则表达式来检测移动设备
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    }

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

    async function handleFileUpload(files) {
        resultsGrid.innerHTML = '';
        processedFiles = [];
        uploadButton.disabled = true;
        downloadButton.disabled = true;

        try {
            // --- 核心改动 ---
            // 1. 将所有上传的文件（包括 ZIP）通过扩展函数转换为一个扁平的图片文件列表
            console.log("开始扩展文件列表...");
            const expansionPromises = Array.from(files).map(expandAndFilterFile);
            const nestedFileArrays = await Promise.all(expansionPromises);
            const allImageFiles = nestedFileArrays.flat(); // [[img1], [img2, img3]] -> [img1, img2, img3]
            console.log(`共找到 ${allImageFiles.length} 个需要处理的图片。`);

            if (allImageFiles.length === 0) {
                resultsGrid.innerHTML = '<p>未在您上传的文件或压缩包中找到支持的图片 (PNG, JPG, BMP)。</p>';
                return; // 提前退出
            }

            // 2. 为所有即将处理的图片创建加载中的卡片
            allImageFiles.forEach(file => createResultCard(file.name));

            // 3. 并行处理所有找到的图片文件
            const processingPromises = allImageFiles.map(file => {
                return processImageFile(file)
                    .then(result => {
                        processedFiles.push(result);
                        // 使用 file.name 来确保我们能更新正确的卡片
                        updateCardStatus(file.name, 'success', '处理成功', result.blob);
                    })
                    .catch(error => {
                        updateCardStatus(file.name, 'error', error.message, null);
                    });
            });

            // 等待所有处理任务完成
            await Promise.allSettled(processingPromises);

        } catch (error) {
            console.error("处理上传文件时发生严重错误:", error);
            resultsGrid.innerHTML = `<p class="status error">处理失败: ${error.message}</p>`;
        } finally {
            // 4. 无论成功与否，最后都恢复按钮状态
            uploadButton.disabled = false;
            if (processedFiles.length > 0) {
                downloadButton.disabled = false;
            }
            fileInput.value = ''; // 清空文件选择器，以便用户可以再次上传相同的文件
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
            const img = document.createElement('img');
            img.src = URL.createObjectURL(blob);
            thumbnailContainer.appendChild(img);

            const statusBadge = document.createElement('span');
            statusBadge.className = 'status success';
            statusBadge.textContent = message;
            statusContainer.appendChild(statusBadge);

        } else if (status === 'error') {
            thumbnailContainer.textContent = '❌';
            const statusBadge = document.createElement('span');
            statusBadge.className = 'status error';
            statusBadge.textContent = message;
            statusContainer.appendChild(statusBadge);
        }
    }

    async function downloadAllAsZip() {
        if (processedFiles.length === 0) return;

        const zip = new JSZip();

        processedFiles.forEach(file => {
            zip.file(file.name, file.blob);
        });

        const zipBlob = await zip.generateAsync({
            type: "blob",
            compression: "DEFLATE",
            compressionOptions: {level: 9}
        });

        const link = document.createElement('a');
        link.href = URL.createObjectURL(zipBlob);
        link.download = `processed-images-${Date.now()}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    }

    // [新函数] 智能下载处理器
    async function handleDownload() {
        if (processedFiles.length === 0) return;

        // 禁用按钮防止重复点击
        downloadButton.disabled = true;
        //if (isMobileDevice()) {
        if (true) {
            // --- 手机端：打包为 ZIP 下载 ---
            console.log("检测到移动设备，打包为 ZIP 下载。");
            const zip = new JSZip();

            processedFiles.forEach(file => {
                zip.file(file.name, file.blob);
            });

            try {
                const zipBlob = await zip.generateAsync({
                    type: "blob",
                    compression: "DEFLATE",
                    compressionOptions: {level: 9}
                });
                downloadFile(zipBlob, `processed-images-${Date.now()}.zip`);
            } catch (error) {
                console.error("ZIP 文件生成失败:", error);
                alert("打包下载失败！");
            }

        } else {
            // --- 电脑端：多文件分别下载 ---
            console.log("检测到桌面设备，将分别下载多个文件。");
            // 为了避免浏览器因为弹出过多下载窗口而拦截，我们使用一个短暂的延迟
            processedFiles.forEach((file, index) => {
                setTimeout(() => {
                    downloadFile(file.blob, file.name);
                }, index * 300); // 每隔 300 毫秒下载一个文件
            });
        }

        // 重新启用按钮
        // 为了避免用户在多文件下载完成前再次点击，可以设置一个更长的延迟
        setTimeout(() => {
            downloadButton.disabled = false;
        }, processedFiles.length * 300 + 500);
    }
})();






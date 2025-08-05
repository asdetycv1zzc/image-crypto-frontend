// script.js (Cleaned Version)
let wasmApi = null;

// 使用刚才指定的导出名来加载模块
createImageProcessorModule().then(Module => {
    console.log("WASM 模块已成功加载并初始化。");

    // 使用 cwrap 包装 C 函数，使其类型安全且易于调用
    // 格式: cwrap('c_function_name', 'return_type', ['arg_type_1', 'arg_type_2', ...])
    // 'number' 代表指针(内存地址)或整数
    wasmApi = {
        perform_encryption: Module.cwrap(
            'perform_encryption',
            null, // void 返回类型
            ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']
        ),
        perform_decryption: Module.cwrap(
            'perform_decryption',
            null, // void 返回类型
            ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']
        ),
        // 保存 Module 实例以用于内存操作
        _malloc: Module._malloc,
        _free: Module._free,
        HEAPU8: Module.HEAPU8,
        HEAPU32: Module.HEAPU32
    };

    // 你可以在这里启用UI元素，表明应用已准备就绪
    document.getElementById('uploadButton').disabled = false;
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

    const BLOCK_SIZE = 32;
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
     * 将所有必要的元数据编码到一行像素中。
     * @param {Uint8Array} metadataRow - 目标行.
     * @param {object} metadata - 包含所有元数据的对象.
     */
    function encodeMetadataToRow(metadataRow, metadata) {
        const view = new DataView(metadataRow.buffer);
        // 使用 32-bit 整数存储 5 个关键值
        view.setUint32(0, metadata.originalWidth, false);
        view.setUint32(4, metadata.originalHeight, false);
        view.setUint32(8, metadata.contentWidth, false);
        view.setUint32(12, metadata.contentHeight, false);
        view.setUint32(16, metadata.totalBlocks, false);
        // 剩余部分可以填充随机数或留空
    }

    /**
     * 从一行像素中解码出所有元数据。
     * @param {Uint8Array} metadataRow - 包含元数据的行.
     * @returns {object} - 解码出的元数据对象.
     */
    function decodeMetadataFromRow(metadataRow) {
        const view = new DataView(metadataRow.buffer);
        return {
            originalWidth: view.getUint32(0, false),
            originalHeight: view.getUint32(4, false),
            contentWidth: view.getUint32(8, false),
            contentHeight: view.getUint32(12, false),
            totalBlocks: view.getUint32(16, false),
        };
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

    async function encryptWithShuffle(pixels, width, height) {
        if (!wasmApi) {
            throw new Error("WASM 模块尚未准备好，请稍后再试。");
        }

        console.log("执行加密 (WASM 优化方案)...");

        // ... (所有元数据、新高度、shuffleMap的计算逻辑保持不变) ...
        const contentWidth = Math.floor(width / BLOCK_SIZE) * BLOCK_SIZE;
        const contentHeight = Math.floor(height / BLOCK_SIZE) * BLOCK_SIZE;
        const blocksX = contentWidth / BLOCK_SIZE;
        const blocksY = contentHeight / BLOCK_SIZE;
        const totalBlocks = blocksX * blocksY;
        const shuffleMap = Array.from({length: totalBlocks}, (_, i) => i);
        shuffleArray(shuffleMap);
        const mapRows = Math.ceil(totalBlocks / width);
        const newHeight = 1 + mapRows + height + 1;
        const outputPixels = new Uint8Array(width * newHeight * CHANNELS);

        // ... (写入元数据和 shuffle map 的 JS 逻辑保持不变) ...
        // ... (因为这部分不是性能瓶颈，且在JS中更容易处理) ...

        // --- WASM 调用核心 ---
        const imageContentStartRow = 1 + mapRows;

        // 1. 在 WASM 内存中为输入/输出数据分配空间
        const originalPixelsPtr = wasmApi._malloc(pixels.length);
        const shuffleMapPtr = wasmApi._malloc(shuffleMap.length * 4); // Uint32Array 每个元素占4字节
        const outputPixelsPtr = wasmApi._malloc(outputPixels.length);

        // 2. 将 JavaScript 数据复制到 WASM 的堆内存中
        wasmApi.HEAPU8.set(pixels, originalPixelsPtr);
        wasmApi.HEAPU32.set(new Uint32Array(shuffleMap), shuffleMapPtr / 4);

        // 3. 调用 WASM 导出的 C 函数执行加密
        wasmApi.perform_encryption(
            originalPixelsPtr,
            width, height, contentWidth, contentHeight,
            shuffleMapPtr,
            outputPixelsPtr,
            imageContentStartRow
        );

        // 4. 从 WASM 内存中将结果复制回 JavaScript
        const wasmResult = new Uint8Array(wasmApi.HEAPU8.buffer, outputPixelsPtr, outputPixels.length);

        // 先把元数据和 map 数据从 JS 缓冲区复制过来
        const headerSize = imageContentStartRow * width * CHANNELS;
        outputPixels.set(outputPixels.subarray(0, headerSize), 0);
        // 再把 WASM 处理的图像数据复制过来
        outputPixels.set(wasmResult.subarray(headerSize), headerSize);

        // 5. 释放 WASM 内存
        wasmApi._free(originalPixelsPtr);
        wasmApi._free(shuffleMapPtr);
        wasmApi._free(outputPixelsPtr);

        // --- 结束 WASM 调用 ---

        // 写入 Magic Row (JS)
        const magicRow = generateMagicRow(width);
        outputPixels.set(magicRow, (newHeight - 1) * width * CHANNELS);

        console.log(`WASM 无损加密完成。`);
        return UPNG.encode([outputPixels.buffer], width, newHeight, 0);
    }


    /**
     * 使用 WASM 模块执行高效的无损解密。
     * 这个函数负责准备数据，调用C语言编译的WASM函数，并处理返回结果。
     * 核心的、计算密集的像素重排工作完全在WASM中完成。
     *
     * @param {Uint8Array} pixels 加密图像的完整像素数据。
     * @param {number} width 加密图像的宽度。
     * @param {number} height 加密图像的高度。
     * @returns {Promise<ArrayBuffer>} 一个包含解密后 PNG 文件数据的 ArrayBuffer。
     */
    async function decryptWithShuffle(pixels, width, height) {
        // 步骤 1: 检查 WASM 模块是否已加载并准备就绪
        if (!wasmApi) {
            // 如果 wasmApi 为 null，说明模块还没加载好，无法继续。
            // 这是必要的安全检查。
            throw new Error("WASM 模块尚未准备好，请稍后再试。");
        }

        console.log("执行解密 (WASM 优化方案)...");

        // 步骤 2: 从像素数据中解码元数据 (这部分逻辑不变，在JS中完成)
        // 这不是性能瓶颈，且在JS中操作更灵活。
        const metadataRow = pixels.subarray(0, width * CHANNELS);
        const metadata = decodeMetadataFromRow(metadataRow);
        const {originalWidth, originalHeight, contentWidth, contentHeight, totalBlocks} = metadata;

        // 验证元数据，确保文件没有损坏
        if (originalWidth !== width) {
            throw new Error(`宽度不匹配: 文件为 ${width}px, 元数据为 ${originalWidth}px.`);
        }
        if (totalBlocks <= 0 || contentWidth <= 0 || contentHeight <= 0) {
            throw new Error(`元数据无效: totalBlocks=${totalBlocks}, contentWidth=${contentWidth}, contentHeight=${contentHeight}`);
        }

        // 步骤 3: 从像素数据中解码 Shuffle Map (同上，在JS中完成)
        const mapRows = Math.ceil(totalBlocks / originalWidth);
        const mapStartOffset = originalWidth * CHANNELS;
        const shuffleMap = new Array(totalBlocks);
        for (let i = 0; i < totalBlocks; i++) {
            shuffleMap[i] = decodeNumberFromPixel(pixels, mapStartOffset + i * CHANNELS);
        }

        // 计算加密内容在完整像素数据中的起始行号
        const encryptedContentStartRow = 1 + mapRows;

        // --- 核心：WASM 交互 ---

        // 定义一些指针变量，初始化为0（空指针）
        let encryptedPixelsPtr = 0;
        let shuffleMapPtr = 0;
        let decryptedPixelsPtr = 0;

        try {
            // 步骤 4: 在 WASM 的线性内存中为所有数据分配空间
            // 这是调用C函数前的准备工作，必须为所有输入和输出数据预留内存。
            const encryptedPixelsSize = pixels.length;
            const shuffleMapSize = shuffleMap.length * 4; // Uint32Array，每个元素4字节
            const decryptedPixelsSize = originalWidth * originalHeight * CHANNELS;

            encryptedPixelsPtr = wasmApi._malloc(encryptedPixelsSize);
            shuffleMapPtr = wasmApi._malloc(shuffleMapSize);
            decryptedPixelsPtr = wasmApi._malloc(decryptedPixelsSize);

            // 如果内存分配失败 (例如，图片太大导致内存不足)，_malloc 会返回 0
            if (!encryptedPixelsPtr || !shuffleMapPtr || !decryptedPixelsPtr) {
                throw new Error("在 WASM 中分配内存失败，可能是图片尺寸过大。");
            }

            // 步骤 5: 将 JavaScript 中的数据复制到 WASM 的内存中
            // 使用 HEAPU8 (Uint8Array 视图) 和 HEAPU32 (Uint32Array 视图) 进行高效复制。
            wasmApi.HEAPU8.set(pixels, encryptedPixelsPtr);
            // 注意: HEAPU32 的偏移量需要除以4，因为它操作的是4字节整数。
            wasmApi.HEAPU32.set(new Uint32Array(shuffleMap), shuffleMapPtr / 4);

            // 步骤 6: 调用导出的 C 函数 `perform_decryption`
            // 所有参数都以数字形式传递（包括指针，它本质上是内存地址的数字表示）。
            wasmApi.perform_decryption(
                encryptedPixelsPtr,           // const unsigned char* restrict encrypted_pixels
                width,                        // int width
                height,                       // int height
                contentWidth,                 // int content_width
                contentHeight,                // int content_height
                shuffleMapPtr,                // const unsigned int* restrict shuffle_map
                encryptedContentStartRow,     // int encrypted_content_start_row
                decryptedPixelsPtr            // unsigned char* restrict decrypted_pixels
            );

            // 步骤 7: 从 WASM 内存中将解密结果复制回 JavaScript
            // 创建一个指向 WASM 内存中结果区域的视图
            const wasmResultView = new Uint8Array(wasmApi.HEAPU8.buffer, decryptedPixelsPtr, decryptedPixelsSize);

            // **至关重要**: 创建一个数据的 JavaScript 副本。
            // 因为 WASM 内存很快就会被释放，我们不能持有对它的引用。
            const finalDecryptedPixels = new Uint8Array(wasmResultView);

            console.log("WASM 无损解密完成。");

            // 步骤 8: 使用解密后的像素数据编码成最终的 PNG 文件
            // UPNG.encode 期望一个 ArrayBuffer 的数组，所以我们传入 .buffer。
            return UPNG.encode([finalDecryptedPixels.buffer], originalWidth, originalHeight, 0);

        } finally {
            // 步骤 9: 无论成功与否，都必须释放 WASM 内存以避免内存泄漏
            // 使用 try...finally 结构确保即使在发生错误时也能执行清理。
            if (encryptedPixelsPtr) wasmApi._free(encryptedPixelsPtr);
            if (shuffleMapPtr) wasmApi._free(shuffleMapPtr);
            if (decryptedPixelsPtr) wasmApi._free(decryptedPixelsPtr);
            console.log("WASM 内存已释放。");
        }
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

        // 禁用按钮防止重复点击
        downloadButton.disabled = true;
        //if (isMobileDevice()) {
        if (true) {
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






// script.js (Cleaned Version)

(function() {
    'use strict';

    // --- 加密/解密核心逻辑 (现在只包含我们自己的函数) ---

    const MAGIC_PIXEL_PATTERN = [
        { r: 0xDE, g: 0xAD, b: 0xBE, a: 0xEF },
        { r: 0xCA, g: 0xFE, b: 0xBA, a: 0xBE },
        { r: 0xFE, g: 0xED, b: 0xDE, a: 0xED },
        { r: 0xDA, g: 0x7A, b: 0xB0, a: 0x55 },
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

    function areBuffersEqual(buf1, buf2) {
        if (!buf1 || !buf2 || buf1.byteLength !== buf2.byteLength) return false;
        // 使用更快的比较方法
        const view1 = new Uint8Array(buf1);
        const view2 = new Uint8Array(buf2);
        for (let i = view1.length - 1; i >= 0; i--) {
            if (view1[i] !== view2[i]) return false;
        }
        return true;
    }

    function isEncrypted(pixelData, width, height) {
        if (height < 2) return false;
        const expectedMagicRow = generateMagicRow(width);
        const lastRowOffset = (height - 1) * width * CHANNELS;
        const lastRow = pixelData.subarray(lastRowOffset, lastRowOffset + width * CHANNELS);
        return areBuffersEqual(lastRow.buffer, expectedMagicRow.buffer);
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
            return { width: img.width, height: img.height, data: new Uint8Array(UPNG.toRGBA8(img)[0]) };
        }
        if (type === 'JPG') {
            // jpeg 是由 jpeg-decoder.js 创建的全局变量
            return jpeg.decode(view, { useTArray: true });
        }
        if (type === 'BMP') {
            // BmpDecoder 是由 bmp-decoder.js 创建的全局变量
            const decoder = new BmpDecoder(Buffer.from(view)); // bmp-js 需要一个 Buffer-like 对象
            return { width: decoder.width, height: decoder.height, data: decoder.getData() };
        }
        throw new Error(`不支持的图片格式 (${type}) 或文件已损坏。`);
    }

    // 图片处理的主函数
    // 在您的 script.js 中，找到并替换这个函数

async function processImageFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                console.log(`--- 开始处理文件: ${file.name} ---`);
                const buffer = event.target.result;
                const { width, height, data: pixels } = decodeImage(buffer);
                
                if (!width || !height || !pixels || pixels.length === 0) {
                    throw new Error("解码失败，无法获取图片数据。");
                }
                
                // [调试] 打印出解码后的图片信息
                console.log(`解码后尺寸: ${width}x${height}`);

                // [调试] 执行 isEncrypted 判断并打印结果
                const isAlreadyEncrypted = isEncrypted(pixels, width, height);
                console.log(`isEncrypted 函数返回: ${isAlreadyEncrypted}`);

                // [调试] 如果是加密文件，我们打印出 magic row 的对比
                if (height >= 2) {
                    const expectedMagicRow = generateMagicRow(width);
                    const lastRowOffset = (height - 1) * width * CHANNELS;
                    const lastRow = pixels.subarray(lastRowOffset, lastRowOffset + width * CHANNELS);
                    console.log("期望的 Magic Row (前16字节):", expectedMagicRow.slice(0, 16));
                    console.log("实际的 Last Row (前16字节):", lastRow.slice(0, 16));
                    // 检查两个 buffer 是否真的不相等
                    if (!areBuffersEqual(lastRow, expectedMagicRow)) {
                        console.warn("警告: Magic Row 对比失败！");
                    }
                }


                let outputPngBuffer;

                if (isAlreadyEncrypted) {
                    console.log("执行解密流程...");
                    // --- 解密流程 ---
                    const originalHeight = height - 2;
                    if (originalHeight <= 0) throw new Error("无效的加密文件，高度不足。");

                    const keyRow = pixels.subarray(0, width * CHANNELS);
                    const encryptedData = pixels.subarray(width * CHANNELS, (height - 1) * width * CHANNELS);
                    const decryptedData = new Uint8Array(width * originalHeight * CHANNELS);
                    
                    for (let i = 0; i < originalHeight; i++) {
                        for (let j = 0; j < width; j++) {
                            const keyPixelIndex = (i * j) % width;
                            const sourceOffset = (i * width + j) * CHANNELS;
                            const keyOffset = keyPixelIndex * CHANNELS;
                            for (let c = 0; c < CHANNELS; c++) {
                                decryptedData[sourceOffset + c] = encryptedData[sourceOffset + c] ^ keyRow[keyOffset + c];
                            }
                        }
                    }
                    outputPngBuffer = UPNG.encode([decryptedData.buffer], width, originalHeight, 0);
                    console.log("解密完成。");
                } else {
                    console.log("执行加密流程...");
                    // --- 加密流程 ---
                    const newHeight = height + 2;
                    const encryptedData = new Uint8Array(width * newHeight * CHANNELS);
                    
                    const keyRow = new Uint8Array(width * CHANNELS);
                    crypto.getRandomValues(keyRow);
                    encryptedData.set(keyRow, 0);

                    for (let i = 0; i < height; i++) {
                        for (let j = 0; j < width; j++) {
                            const keyPixelIndex = (i * j) % width;
                            const sourceOffset = (i * width + j) * CHANNELS;
                            const destOffset = ((i + 1) * width + j) * CHANNELS;
                            const keyOffset = keyPixelIndex * CHANNELS;
                            for (let c = 0; c < CHANNELS; c++) {
                                encryptedData[destOffset + c] = pixels[sourceOffset + c] ^ keyRow[keyOffset + c];
                            }
                        }
                    }

                    const magicRow = generateMagicRow(width);
                    encryptedData.set(magicRow, (newHeight - 1) * width * CHANNELS);
                    console.log("加密时写入的 Magic Row (前16字节):", magicRow.slice(0, 16));
                    outputPngBuffer = UPNG.encode([encryptedData.buffer], width, newHeight, 0);
                    console.log("加密完成。");
                }
                
                const imageBlob = new Blob([outputPngBuffer], { type: 'image/png' });
                const newFileName = isAlreadyEncrypted ? `decrypted-${file.name.replace(/\.png$/i, '')}` : `encrypted-${file.name.split('.').slice(0, -1).join('.') || file.name}.png`;
                
                resolve({ name: newFileName, blob: imageBlob });
            } catch (error) {
                console.error("处理图片时发生错误:", error);
                reject(error);
            }
        };
        reader.onerror = (error) => reject(error);
        reader.readAsArrayBuffer(file);
    });
}

    // --- 前端交互逻辑 ---
    const fileInput = document.getElementById('fileInput');
    const uploadButton = document.getElementById('uploadButton');
    const downloadButton = document.getElementById('downloadButton');
    const resultsGrid = document.getElementById('results');
    let processedFiles = [];

    uploadButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (event) => {
        const files = event.target.files;
        if (files.length > 0) {
            handleFileUpload(Array.from(files));
        }
    });
    downloadButton.addEventListener('click', downloadAllAsZip);

    async function handleFileUpload(files) {
        resultsGrid.innerHTML = '';
        processedFiles = [];
        uploadButton.disabled = true;
        downloadButton.disabled = true;

        files.forEach(file => createResultCard(file.name));

        const promises = files.map(file => {
            return processImageFile(file)
                .then(result => {
                    // 成功后，将结果存储起来，并更新卡片
                    processedFiles.push(result);
                    updateCardStatus(file.name, 'success', '处理成功', result.blob);
                })
                .catch(error => {
                    // 失败后，只更新卡片
                    updateCardStatus(file.name, 'error', error.message, null);
                });
        });

        await Promise.allSettled(promises);

        uploadButton.disabled = false;
        if (processedFiles.length > 0) {
            downloadButton.disabled = false;
        }
        fileInput.value = ''; 
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
            compressionOptions: { level: 9 }
        });

        const link = document.createElement('a');
        link.href = URL.createObjectURL(zipBlob);
        link.download = `processed-images-${Date.now()}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    }
})();



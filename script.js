document.addEventListener('DOMContentLoaded', () => {
    const WORKER_URL = 'https://image-api.fragrant-sound-5d2a.workers.dev/';

    const fileInput = document.getElementById('fileInput');
    const uploadButton = document.getElementById('uploadButton');
    const downloadButton = document.getElementById('downloadButton');
    const resultsGrid = document.getElementById('results');

    // 存储成功处理后的文件 { name: string, blob: Blob }
    let processedFiles = [];

    // 点击“上传按钮”时，触发隐藏的文件选择框
    uploadButton.addEventListener('click', () => fileInput.click());

    // 当用户选择了文件后
    fileInput.addEventListener('change', (event) => {
        const files = event.target.files;
        if (files.length > 0) {
            handleFileUpload(files);
        }
    });
    
    // 点击“下载按钮”时
    downloadButton.addEventListener('click', downloadAllAsZip);

    async function handleFileUpload(files) {
        // 重置状态
        resultsGrid.innerHTML = '';
        processedFiles = [];
        uploadButton.disabled = true;
        downloadButton.disabled = true;

        // 为每个文件创建一个占位卡片
        const fileList = Array.from(files);
        fileList.forEach(file => createResultCard(file.name));

        // 并行处理所有文件
        const promises = fileList.map(file => processImage(file));
        await Promise.allSettled(promises);

        // 全部处理完成后
        uploadButton.disabled = false;
        if (processedFiles.length > 0) {
            downloadButton.disabled = false;
        }

        // 清空文件输入框的值，以便用户可以重新上传相同的文件
        fileInput.value = ''; 
    }

    // 为单个文件创建结果显示卡片
    function createResultCard(fileName) {
        const card = document.createElement('div');
        card.className = 'result-card';
        card.id = `card-${fileName}`;
        card.innerHTML = `
            <div class="thumbnail-container">
                <div class="spinner"></div>
            </div>
            <p>${fileName}</p>
            <div class="status-container"></div>
        `;
        resultsGrid.appendChild(card);
    }

    // 更新卡片的状态
    function updateCardStatus(fileName, status, message, blob = null) {
        const card = document.getElementById(`card-${fileName}`);
        if (!card) return;

        const thumbnailContainer = card.querySelector('.thumbnail-container');
        const statusContainer = card.querySelector('.status-container');

        thumbnailContainer.innerHTML = ''; // 清空 spinner
        statusContainer.innerHTML = '';

        if (status === 'success') {
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


    async function processImage(file) {
        try {
            const response = await fetch(WORKER_URL, {
                method: 'POST',
                headers: {
                    // 发送原始文件的 Content-Type
                    'Content-Type': file.type,
                },
                body: file,
            });

            if (!response.ok) {
                // 如果服务器返回错误（例如 500）
                const errorText = await response.text();
                throw new Error(`服务器错误: ${response.status} ${errorText}`);
            }

            // 获取返回的图片 blob 数据
            const imageBlob = await response.blob();
            
            // 为下载准备文件名
            const isEncrypted = file.name.endsWith('.png');
            const newFileName = isEncrypted ? `decrypted-${file.name}` : `encrypted-${file.name.split('.').slice(0, -1).join('.')}.png`;

            // 存储成功的结果
            processedFiles.push({ name: newFileName, blob: imageBlob });
            updateCardStatus(file.name, 'success', '处理成功', imageBlob);

        } catch (error) {
            console.error(`处理文件 ${file.name} 失败:`, error);
            updateCardStatus(file.name, 'error', '处理失败');
        }
    }

    async function downloadAllAsZip() {
        if (processedFiles.length === 0) return;

        const zip = new JSZip();
        
        // 将所有处理过的文件添加到 zip 实例中
        processedFiles.forEach(file => {
            zip.file(file.name, file.blob);
        });

        // 生成 zip 文件内容
        const zipBlob = await zip.generateAsync({
            type: "blob",
            compression: "DEFLATE",
            compressionOptions: {
                level: 9
            }
        });

        // 创建一个临时链接来触发下载
        const link = document.createElement('a');
        link.href = URL.createObjectURL(zipBlob);
        link.download = `processed-images-${Date.now()}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // 释放 URL 对象以节省内存
        URL.revokeObjectURL(link.href);
    }
});
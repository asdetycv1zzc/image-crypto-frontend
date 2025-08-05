export function decodeImage(buffer) {
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

const MAGIC_PIXEL_PATTERN = [
    {r: 0xDE, g: 0xAD, b: 0xBE, a: 0xEF},
    {r: 0xCA, g: 0xFE, b: 0xBA, a: 0xBE},
    {r: 0xFE, g: 0xED, b: 0xDE, a: 0xED},
    {r: 0xDA, g: 0x7A, b: 0xB0, a: 0x55},
];
const CHANNELS = 4;

export function generateMagicRow(width) {
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

export function areBuffersEqual(view1, view2) {
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

export function isEncrypted(pixelData, width, height) {
    if (height < 2) return false;
    const expectedMagicRow = generateMagicRow(width);
    const lastRowOffset = (height - 1) * width * CHANNELS;
    const lastRow = pixelData.subarray(lastRowOffset, lastRowOffset + width * CHANNELS);
    return areBuffersEqual(lastRow, expectedMagicRow);
}
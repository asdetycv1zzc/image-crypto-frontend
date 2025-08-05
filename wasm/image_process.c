#include <string.h> // 用于 memcpy
#include <emscripten/emscripten.h>
#include <wasm_simd128.h>

// --- 常量定义 ---
const int CHANNELS = 4;
const int BLOCK_SIZE = 32;
void memcpy_simd(unsigned char* restrict dest, const unsigned char* restrict src, size_t n);
/*
 * C 版本的 copyBlock 函数 (激进优化版)
 * 优化点:
 * 1. static inline: 强烈建议编译器将此函数内联，消除在主循环中成千上万次函数调用的开销。
 * 2. restrict: 对 src 和 dest 指针使用 restrict 关键字。这是对编译器的承诺，
 *    表明这两个指针指向的内存区域绝不重叠。这解锁了最高级别的优化，
 *    因为它允许编译器自由地重排读写指令，并且更容易生成 SIMD (向量化) 指令。
 *
 * 对应的 JavaScript 代码: (逻辑等同于原版)
 * function copyBlock(...) { ... }
 */
static inline void copyBlock(
    const unsigned char* restrict src, int srcWidth, int srcContentHeight, int srcStartRow,
    unsigned char* restrict dest, int destWidth, int destContentHeight, int destStartRow,
    int destBlockX, int destBlockY, int srcBlockX, int srcBlockY) {

    // 计算起始像素坐标
    int srcStartX = srcBlockX * BLOCK_SIZE;
    int srcStartY = srcBlockY * BLOCK_SIZE;
    int destStartX = destBlockX * BLOCK_SIZE;
    int destStartY = destBlockY * BLOCK_SIZE;

    // 处理边缘不完整的块，计算有效复制尺寸
    int effectiveBlockWidth = (srcStartX + BLOCK_SIZE > srcWidth) ? (srcWidth - srcStartX) : BLOCK_SIZE;
    int effectiveBlockHeight = (srcStartY + BLOCK_SIZE > srcContentHeight) ? (srcContentHeight - srcStartY) : BLOCK_SIZE;

    // 如果目标块完全在内容区域之外，则跳过
    if (destStartY >= destContentHeight) {
        return;
    }

    // 计算单行需要复制的字节数
    size_t bytesToCopy = (size_t)effectiveBlockWidth * CHANNELS;

    // 逐行复制块内容
    for (int y = 0; y < effectiveBlockHeight; y++) {
        if (destStartY + y >= destContentHeight) {
            continue;
        }

        // 计算源和目标在完整缓冲区中的指针地址
        const unsigned char* src_ptr = src + ((size_t)(srcStartY + y + srcStartRow) * srcWidth + srcStartX) * CHANNELS;
        unsigned char* dest_ptr = dest + ((size_t)(destStartY + y + destStartRow) * destWidth + destStartX) * CHANNELS;

        // memcpy 是内存复制的黄金标准。在-O3优化下，编译器会将其转换为
        // 最高效的底层指令，极有可能利用 WASM 的 128-bit SIMD 指令集，
        // 一次性复制16个字节（4个像素），性能远超手动循环。
        memcpy_simd(dest_ptr, src_ptr, bytesToCopy);
    }
}

/*
 * C 版本的加密核心逻辑 (激进优化版)
 * 优化点:
 * 1. restrict: 对所有输入和输出指针使用，向编译器保证它们互不重叠。
 * 2. const: 明确标识哪些数据是只读的。
 *
 * 对应的 JavaScript 代码 (encryptWithShuffle 函数的核心循环):
 * for (let i = 0; i < totalBlocks; i++) { ... copyBlock(...) ... }
 */
EMSCRIPTEN_KEEPALIVE
void perform_encryption(
    const unsigned char* restrict original_pixels,
    int width, int height,
    int content_width, int content_height,
    const unsigned int* restrict shuffle_map,
    unsigned char* restrict output_pixels,
    int output_start_row)
{
    int blocksX = content_width / BLOCK_SIZE;
    int totalBlocks = blocksX * (content_height / BLOCK_SIZE);

    // 步骤1: 完整复制原始图像。memcpy会处理好这里的性能。
    size_t full_image_size = (size_t)width * height * CHANNELS;
    unsigned char* image_dest_start = output_pixels + (size_t)output_start_row * width * CHANNELS;
    memcpy_simd(image_dest_start, original_pixels, full_image_size);

    // 步骤2: 迭代并使用打乱的块覆盖内容区域。
    // 由于 copyBlock 被内联，这里的循环体会被展开，减少大量开销。
    for (int i = 0; i < totalBlocks; i++) {
        unsigned int originalBlockIndex = shuffle_map[i];
        copyBlock(
            original_pixels, width, height, 0,
            output_pixels, width, height, output_start_row,
            i % blocksX, i / blocksX, // destBlockX, destBlockY
            originalBlockIndex % blocksX, originalBlockIndex / blocksX // srcBlockX, srcBlockY
        );
    }
}

/*
 * C 版本的解密核心逻辑 (激进优化版)
 * 优化点: (同加密函数)
 * 1. restrict: 保证指针不重叠，为编译器优化铺路。
 * 2. const: 标记只读数据。
 *
 * 对应的 JavaScript 代码 (decryptWithShuffle 函数的核心循环):
 * for (let i = 0; i < totalBlocks; i++) { ... copyBlock(...) ... }
 */
EMSCRIPTEN_KEEPALIVE
void perform_decryption(
    const unsigned char* restrict encrypted_pixels,
    int width, int height,
    int content_width, int content_height,
    const unsigned int* restrict shuffle_map,
    int encrypted_content_start_row,
    unsigned char* restrict decrypted_pixels)
{
    int blocksX = content_width / BLOCK_SIZE;
    int totalBlocks = blocksX * (content_height / BLOCK_SIZE);

    // 步骤1: 完整复制加密图像的内容部分。
    // 注意：这里的原始图像高度是 content_height，因为解密后我们只需要这个尺寸。
    const unsigned char* encrypted_content_start = encrypted_pixels + (size_t)encrypted_content_start_row * width * CHANNELS;
    size_t original_image_size = (size_t)width * content_height * CHANNELS;
    memcpy_simd(decrypted_pixels, encrypted_content_start, original_image_size);

    // 步骤2: 根据 shuffle map 将块从源（加密数据）还原到目标（解密画布）的正确位置。
    for (int i = 0; i < totalBlocks; i++) {
        unsigned int originalBlockIndex = shuffle_map[i];
        copyBlock(
            encrypted_pixels, width, height, encrypted_content_start_row,
            decrypted_pixels, width, content_height, 0,
            originalBlockIndex % blocksX, originalBlockIndex / blocksX, // destBlockX, destBlockY
            i % blocksX, i / blocksX // srcBlockX, srcBlockY
        );
    }
}

EMSCRIPTEN_KEEPALIVE
void memcpy_simd(unsigned char* restrict dest, const unsigned char* restrict src, size_t n) {
    size_t i = 0;
    // 一次处理16个字节 (128位)
    for (; i + 16 <= n; i += 16) {
        // 从内存加载128位数据到向量寄存器
        v128_t chunk = wasm_v128_load(&src[i]);
        // 将向量寄存器的数据存储回内存
        wasm_v128_store(&dest[i], chunk);
    }
    // 处理剩余不足16字节的数据
    for (; i < n; i++) {
        dest[i] = src[i];
    }
}
#include <string.h> // 用于 memcpy
#include <stdlib.h>
#include <emscripten/emscripten.h>
#include <wasm_simd128.h>

// --- 常量定义 ---
const int CHANNELS = 4;
const int BLOCK_SIZE = 32;

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
    const int blocksX = content_width / BLOCK_SIZE;
    const int blocksY = content_height / BLOCK_SIZE;

    // 步骤1: 完整复制原始图像。memcpy是最高效的方式。
    const size_t full_image_size = (size_t)width * height * CHANNELS;
    unsigned char* image_dest_start = output_pixels + (size_t)output_start_row * width * CHANNELS;
    memcpy(image_dest_start, original_pixels, full_image_size);

    // 步骤2: 使用嵌套循环迭代所有目标块，消除 div/mod。
    int shuffle_map_idx = 0;
    for (int destBlockY = 0; destBlockY < blocksY; ++destBlockY) {
        for (int destBlockX = 0; destBlockX < blocksX; ++destBlockX) {
            // --- copyBlock 逻辑开始 (完全内联) ---
            const unsigned int originalBlockIndex = shuffle_map[shuffle_map_idx++];
            const int srcBlockX = originalBlockIndex % blocksX;
            const int srcBlockY = originalBlockIndex / blocksX;

            // 计算源和目标的起始像素坐标
            const int srcStartX = srcBlockX * BLOCK_SIZE;
            const int srcStartY = srcBlockY * BLOCK_SIZE;
            const int destStartX = destBlockX * BLOCK_SIZE;
            const int destStartY = destBlockY * BLOCK_SIZE;

            // 处理边缘不完整的块，计算有效复制尺寸
            // 这些计算在内部循环之外，对于每个块只执行一次
            const int effectiveBlockWidth = (srcStartX + BLOCK_SIZE > width) ? (width - srcStartX) : BLOCK_SIZE;
            const int effectiveBlockHeight = (srcStartY + BLOCK_SIZE > height) ? (height - srcStartY) : BLOCK_SIZE;

            // 如果目标块完全在内容区域之外，则理论上不应发生，但作为安全检查
            if (destStartY >= height) {
                continue;
            }

            const size_t bytesToCopy = (size_t)effectiveBlockWidth * CHANNELS;

            // 逐行复制块内容
            for (int y = 0; y < effectiveBlockHeight; ++y) {
                 // 计算源和目标在完整缓冲区中的指针地址
                const unsigned char* src_ptr = original_pixels + ((size_t)(srcStartY + y) * width + srcStartX) * CHANNELS;
                unsigned char* dest_ptr = image_dest_start + ((size_t)(destStartY + y) * width + destStartX) * CHANNELS;

                // 使用标准 memcpy，编译器会将其优化为SIMD指令
                memcpy(dest_ptr, src_ptr, bytesToCopy);
            }
            // --- copyBlock 逻辑结束 ---
        }
    }
}

/**
 * C 版本的解密核心逻辑 (最终修正版 - 无需修改函数签名)
 * 修正点:
 * 1. 在函数内部根据输入参数推导出原始图像的高度(originalHeight)，避免了修改函数签名。
 * 2. 基于推导出的 originalHeight 执行一次安全、大小正确的 memcpy，将加密图像的
 *    内容部分（包括未扰乱的底部行）复制到输出缓冲区，这既避免了内存溢出，
 *    也正确地初始化了输出图像。
 * 3. 保持了之前对 effectiveBlockHeight 的鲁棒性计算，以处理跨越 content_height 边界的图块。
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
    const int blocksX = content_width / BLOCK_SIZE;
    const int blocksY = content_height / BLOCK_SIZE;

    // --- 步骤 1: 根据输入参数推导出原始图像的高度 ---
    // 加密图像总高度(height) = 内容起始行 + 原始高度 + 1个magic行
    // 因此: originalHeight = height - encrypted_content_start_row - 1
    const int originalHeight = height - encrypted_content_start_row - 1;

    // --- 步骤 2: 安全地初始化输出缓冲区 ---
    // 定位到加密数据中实际图像内容的起始指针
    const unsigned char* encrypted_content_start = encrypted_pixels + (size_t)encrypted_content_start_row * width * CHANNELS;
    // 计算原始图像内容的总字节大小
    const size_t original_image_size = (size_t)width * originalHeight * CHANNELS;

    // 将加密图像的内容部分完整复制到输出缓冲区。
    // 这是安全的操作，因为 original_image_size 正好对应 decrypted_pixels 的分配大小。
    memcpy(decrypted_pixels, encrypted_content_start, original_image_size);

    // --- 步骤 3: 执行核心解密循环 ---
    // 这个循环现在是在一个已正确初始化的、大小正确的缓冲区上进行覆盖操作。
    int shuffle_map_idx = 0;
    for (int srcBlockY = 0; srcBlockY < blocksY; ++srcBlockY) {
        for (int srcBlockX = 0; srcBlockX < blocksX; ++srcBlockX) {
            const unsigned int originalBlockIndex = shuffle_map[shuffle_map_idx++];
            const int destBlockX = originalBlockIndex % blocksX;
            const int destBlockY = originalBlockIndex / blocksX;

            const int srcStartX = srcBlockX * BLOCK_SIZE;
            const int srcStartY = srcBlockY * BLOCK_SIZE;
            const int destStartX = destBlockX * BLOCK_SIZE;
            const int destStartY = destBlockY * BLOCK_SIZE;

            const int effectiveBlockWidth = (srcStartX + BLOCK_SIZE > width) ? (width - srcStartX) : BLOCK_SIZE;

            // 同时考虑源和目标的边界，计算块的有效高度
            int src_h = (srcStartY + BLOCK_SIZE > content_height) ? (content_height - srcStartY) : BLOCK_SIZE;
            int dest_h = (destStartY + BLOCK_SIZE > content_height) ? (content_height - destStartY) : BLOCK_SIZE;
            int effectiveBlockHeight = (src_h < dest_h) ? src_h : dest_h;

            if (effectiveBlockHeight <= 0) {
                continue;
            }

            const size_t bytesToCopy = (size_t)effectiveBlockWidth * CHANNELS;

            for (int y = 0; y < effectiveBlockHeight; ++y) {
                // 读取指针: 基于加密内容区的起点 `encrypted_content_start`
                const unsigned char* src_ptr = encrypted_content_start + ((size_t)(srcStartY + y) * width + srcStartX) * CHANNELS;
                // 写入指针: 基于输出缓冲区 `decrypted_pixels`
                unsigned char* dest_ptr = decrypted_pixels + ((size_t)(destStartY + y) * width + destStartX) * CHANNELS;

                memcpy(dest_ptr, src_ptr, bytesToCopy);
            }
        }
    }
}
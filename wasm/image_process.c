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

/*
 * C 版本的解密核心逻辑 (修正版)
 * 修正点:
 * 1. (关键修复) 在解密循环开始前，完整复制整个加密图像到输出缓冲区。
 *    这确保了在加密过程中未被触及的像素（如图像底部）被正确地保留下来。
 * 2. restrict: 保证指针不重叠，为编译器优化铺路。
 * 3. const: 标记只读数据。
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

    // 步骤 1: 完整复制整个加密图像到解密缓冲区。 (*** 此处为关键修正 ***)
    // 这一步确保了图像中所有未被加密算法触及的部分 (例如底部边缘)
    // 能够被原样保留到最终的解密图像中。
    const size_t full_image_size = (size_t)width * height * CHANNELS;
    memcpy(decrypted_pixels, encrypted_pixels, full_image_size);

    // 定义一个指向加密内容区域起点的指针，用于后续读取源数据块。
    const unsigned char* encrypted_content_start = encrypted_pixels + (size_t)encrypted_content_start_row * width * CHANNELS;

    // 步骤 2: 根据 shuffle map 将块从源（加密数据）还原到目标（解密画布）的正确位置。
    // 这个循环现在是在一个已经包含完整图像数据的副本上进行“覆盖”操作。
    int shuffle_map_idx = 0;
    for (int srcBlockY = 0; srcBlockY < blocksY; ++srcBlockY) {
        for (int srcBlockX = 0; srcBlockX < blocksX; ++srcBlockX) {
            // --- copyBlock 逻辑开始 (完全内联) ---
            const unsigned int originalBlockIndex = shuffle_map[shuffle_map_idx++];
            const int destBlockX = originalBlockIndex % blocksX;
            const int destBlockY = originalBlockIndex / blocksX;

            // 计算源和目标的起始像素坐标
            const int srcStartX = srcBlockX * BLOCK_SIZE;
            const int srcStartY = srcBlockY * BLOCK_SIZE;
            const int destStartX = destBlockX * BLOCK_SIZE;
            const int destStartY = destBlockY * BLOCK_SIZE;

            // 处理边缘不完整的块
            const int effectiveBlockWidth = (srcStartX + BLOCK_SIZE > width) ? (width - srcStartX) : BLOCK_SIZE;
            // 解密时，源和目标的高度都限制在 content_height 内
            const int effectiveBlockHeight = (srcStartY + BLOCK_SIZE > content_height) ? (content_height - srcStartY) : BLOCK_SIZE;

            if (destStartY >= content_height) {
                continue;
            }

            const size_t bytesToCopy = (size_t)effectiveBlockWidth * CHANNELS;

            for (int y = 0; y < effectiveBlockHeight; ++y) {
                if (destStartY + y >= content_height) {
                    continue;
                }
                // 从加密图像的内容区域读取源数据
                const unsigned char* src_ptr = encrypted_content_start + ((size_t)(srcStartY + y) * width + srcStartX) * CHANNELS;
                // 将数据写入到我们已经创建了完整副本的解密缓冲区
                unsigned char* dest_ptr = decrypted_pixels + ((size_t)(destStartY + y) * width + destStartX) * CHANNELS;

                memcpy(dest_ptr, src_ptr, bytesToCopy);
            }
            // --- copyBlock 逻辑结束 ---
        }
    }
}
#include <stdlib.h> // 用于 malloc 和 free
#include <emscripten/emscripten.h> // 用于 EMSCRIPTEN_KEEPALIVE

// =======================================================================
// ==               STB 库的实现包含 (重要!)                          ==
// =======================================================================
// 定义这些宏告诉 stb.h 文件在此处生成它们的函数实现。
// 只需要在一个 C/C++ 文件中这样做。
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

EMSCRIPTEN_KEEPALIVE
extern void memcpy_simd(unsigned char* restrict dest, const unsigned char* restrict src, size_t n);

// =======================================================================
// ==               图像解码 (替换 decodeImage)                         ==
// =======================================================================

// 这个函数将从JavaScript中被调用，用来解码图片
EMSCRIPTEN_KEEPALIVE
unsigned char* decode_image_wasm(
    const unsigned char* image_data, // [输入] 原始图片文件的二进制数据
    int image_data_size,             // [输入] 数据的大小
    int* out_width,                  // [输出] 用于返回图片宽度的指针
    int* out_height                 // [输出] 用于返回图片高度的指针
) {
    int channels_in_file; // 我们不关心这个，但stbi_load_from_memory需要它

    // 调用stb_image的核心函数来从内存中解码图片
    // stbi_load_from_memory 会自动识别PNG, JPEG, BMP等多种格式
    // 最后一个参数 4 表示我们强制要求输出为 RGBA (4通道) 格式
    unsigned char* decoded_data = stbi_load_from_memory(
        image_data,
        image_data_size,
        out_width,
        out_height,
        &channels_in_file,
        4 // 强制输出为 RGBA
    );

    // stbi_load_from_memory 内部使用了 malloc，所以返回的指针
    // 需要在JavaScript中通过调用 C 的 free 来释放。

    return decoded_data;
}


// =======================================================================
// ==               图像编码 (替换 UPNG.encode)                         ==
// =======================================================================

// 用于 stbi_write_png_to_func 的辅助结构体
// C语言没有闭包，所以我们用一个 struct 来在回调函数间传递状态
typedef struct {
    unsigned char* buffer;
    size_t size;
} WriteContext;

// 这是传递给 stbi_write_png_to_func 的回调函数
// stb 会一块一块地调用这个函数，把编码好的PNG数据传给我们
static inline void write_func_callback(void* context, void* data, int size) {
    WriteContext* ctx = (WriteContext*)context;

    // 重新分配内存以容纳新的数据块
    // 注意：在实际生产中，更高效的做法是预分配一个大块或指数增长，
    // 但 realloc 对于这里的简单性来说足够了。
    ctx->buffer = (unsigned char*)realloc(ctx->buffer, ctx->size + size);
    if (ctx->buffer == NULL) {
        // 内存分配失败处理
        return;
    }

    // 将新的数据块拷贝到我们缓冲区的末尾
    memcpy_simd(ctx->buffer + ctx->size, data, size);
    ctx->size += size;
}

// 这个函数将从JavaScript中被调用，用来编码PNG图片
EMSCRIPTEN_KEEPALIVE
unsigned char* encode_png_wasm(
    const unsigned char* image_data, // [输入] 原始的 RGBA 像素数据
    int width,                       // [输入] 图片宽度
    int height,                      // [输入] 图片高度
    size_t* out_size                 // [输出] 用于返回最终PNG文件大小的指针
) {
    // 1. 初始化我们的写入上下文
    WriteContext ctx = { .buffer = NULL, .size = 0 };

    // 2. 调用stb_image_write的核心函数
    // 它会进行PNG编码，并通过回调函数(write_func_callback)把数据交给我们
    // 最后一个参数 0 表示默认的PNG压缩级别
    int success = stbi_write_png_to_func(
        write_func_callback,
        &ctx,                  // 传递我们的上下文
        width,
        height,
        4,                     // 4个通道 (RGBA)
        image_data,
        width * 4              // 每行的字节数 (stride)
    );

    if (!success) {
        // 如果编码失败，释放可能已分配的内存
        if (ctx.buffer) free(ctx.buffer);
        *out_size = 0;
        return NULL;
    }

    // 3. 将最终大小写回输出参数
    *out_size = ctx.size;

    // 4. 返回指向我们自己分配和填充的内存的指针
    return ctx.buffer;
}
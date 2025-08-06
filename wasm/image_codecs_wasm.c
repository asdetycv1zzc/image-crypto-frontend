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
    size_t capacity; // 记录已分配内存的总大小
} WriteContext;

// 这是传递给 stbi_write_png_to_func 的回调函数
// stb 会一块一块地调用这个函数，把编码好的PNG数据传给我们
static void write_func_callback(void* context, void* data, int size) {
    WriteContext* ctx = (WriteContext*)context;

    // 检查是否有足够容量，理论上预分配后不应该需要realloc
    if (ctx->size + size > ctx->capacity) {
        // 这是一个备用方案，以防预分配的内存不足。
        // 在实践中，如果预分配大小合理，这里几乎不会被执行。
        size_t new_capacity = (ctx->size + size) * 1.5; // 指数增长
        ctx->buffer = (unsigned char*)realloc(ctx->buffer, new_capacity);
        ctx->capacity = new_capacity;
    }

    // 断言，确保我们不会写入越界
    assert(ctx->buffer != NULL && "Memory allocation failed");
    assert(ctx->size + size <= ctx->capacity && "Write exceeds allocated capacity");

    // 将新的数据块拷贝到我们缓冲区的末尾
    memcpy(ctx->buffer + ctx->size, data, size);
    ctx->size += size;
}

// 这个函数将从JavaScript中被调用，用来编码PNG图片
EMSCRIPTEN_KEEPALIVE
unsigned char* encode_png_wasm(
    const unsigned char* image_data,
    int width,
    int height,
    size_t* out_size
) {
    // 优化1: 预分配一个足够大的缓冲区。
    // 最坏情况是无压缩，RGBA大小为 width * height * 4。我们分配这个大小。
    // PNG通常会压缩得更小，所以这个大小绰绰有余。
    size_t initial_capacity = (size_t)width * height * 4 * 2;
    unsigned char* initial_buffer = (unsigned char*)malloc(initial_capacity);

    if (initial_buffer == NULL) {
        *out_size = 0;
        return NULL;
    }

    // 1. 初始化我们的写入上下文
    WriteContext ctx = {
        .buffer = initial_buffer,
        .size = 0,
        .capacity = initial_capacity
    };

    // 2. 调用stb_image_write的核心函数
    int success = stbi_write_png_to_func(
        write_func_callback,
        &ctx,
        width,
        height,
        4,
        image_data,
        width * 4
    );

    if (!success) {
        if (ctx.buffer) free(ctx.buffer);
        *out_size = 0;
        return NULL;
    }

    // 优化2: 单次收缩内存。
    // 编码完成后，我们知道确切的大小 (ctx.size)。
    // 调用一次 realloc 将缓冲区收缩到正好大小，避免浪费内存。
    // 这比在循环中多次调用realloc快得多。
    unsigned char* final_buffer = (unsigned char*)realloc(ctx.buffer, ctx.size);
    if (final_buffer == NULL && ctx.size > 0) {
        // realloc失败，但旧缓冲区仍然有效
        // 这种情况非常罕见，但为了代码健壮性我们返回旧缓冲区
        *out_size = ctx.capacity; // JS侧需要知道这是未收缩的缓冲区
        return ctx.buffer;
    }


    // 3. 将最终大小写回输出参数
    *out_size = ctx.size;

    // 4. 返回指向我们自己分配和填充的内存的指针
    return final_buffer;
}
/* A stand-in for lvgl.h, holding the font structures copied from LVGL's own
 * src/font/lv_font.h and src/font/lv_font_fmt_txt.h, so the generated LVGL fonts can
 * be compiled here against the real field names and types. Define LVGL_MAJOR as 8 or
 * 9 to check either version.
 */
#ifndef LVGL_STUB_H
#define LVGL_STUB_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#ifndef LVGL_MAJOR
#define LVGL_MAJOR 8
#endif
#define LVGL_VERSION_MAJOR LVGL_MAJOR
#define LV_VERSION_CHECK(m, n, p) (LVGL_MAJOR > (m) || (LVGL_MAJOR == (m) && 99 >= (n)))

#define LV_ATTRIBUTE_LARGE_CONST

typedef struct {
    uint32_t bitmap_index : 20;
    uint32_t adv_w : 12;
    uint8_t box_w;
    uint8_t box_h;
    int8_t ofs_x;
    int8_t ofs_y;
} lv_font_fmt_txt_glyph_dsc_t;

enum {
    LV_FONT_FMT_TXT_CMAP_FORMAT0_FULL,
    LV_FONT_FMT_TXT_CMAP_SPARSE_FULL,
    LV_FONT_FMT_TXT_CMAP_FORMAT0_TINY,
    LV_FONT_FMT_TXT_CMAP_SPARSE_TINY,
};
typedef uint8_t lv_font_fmt_txt_cmap_type_t;

typedef struct {
    uint32_t range_start;
    uint16_t range_length;
    uint16_t glyph_id_start;
    const uint16_t * unicode_list;
    const void * glyph_id_ofs_list;
    uint16_t list_length;
    lv_font_fmt_txt_cmap_type_t type;
} lv_font_fmt_txt_cmap_t;

typedef struct {
    uint32_t last_letter;
    uint32_t last_glyph_id;
} lv_font_fmt_txt_glyph_cache_t;

typedef struct {
    const uint8_t * glyph_bitmap;
    const lv_font_fmt_txt_glyph_dsc_t * glyph_dsc;
    const lv_font_fmt_txt_cmap_t * cmaps;
    const void * kern_dsc;
    uint16_t kern_scale;
    uint16_t cmap_num : 9;
    uint16_t bpp : 4;
    uint16_t kern_classes : 1;
    uint16_t bitmap_format : 2;
#if LVGL_MAJOR == 8
    lv_font_fmt_txt_glyph_cache_t * cache;
#endif
} lv_font_fmt_txt_dsc_t;

enum { LV_FONT_SUBPX_NONE, LV_FONT_SUBPX_HOR, LV_FONT_SUBPX_VER, LV_FONT_SUBPX_BOTH };

#if LVGL_MAJOR == 8

typedef int16_t lv_coord_t;
struct _lv_font_t;
typedef struct { uint16_t adv_w, box_w, box_h; int16_t ofs_x, ofs_y; uint8_t bpp; }
    lv_font_glyph_dsc_t;

typedef struct _lv_font_t {
    bool (*get_glyph_dsc)(const struct _lv_font_t *, lv_font_glyph_dsc_t *, uint32_t, uint32_t);
    const uint8_t * (*get_glyph_bitmap)(const struct _lv_font_t *, uint32_t);
    lv_coord_t line_height;
    lv_coord_t base_line;
    uint8_t subpx : 2;
    int8_t underline_position;
    int8_t underline_thickness;
    const void * dsc;
    const struct _lv_font_t * fallback;
} lv_font_t;

bool lv_font_get_glyph_dsc_fmt_txt(const lv_font_t *, lv_font_glyph_dsc_t *, uint32_t, uint32_t);
const uint8_t * lv_font_get_bitmap_fmt_txt(const lv_font_t *, uint32_t);

#else   /* LVGL 9 */

typedef struct lv_font_t lv_font_t;
typedef struct lv_draw_buf_t lv_draw_buf_t;
typedef struct {
    const lv_font_t * resolved_font;
    uint16_t adv_w, box_w, box_h;
    int16_t ofs_x, ofs_y;
    uint8_t bpp : 4;
    uint8_t is_placeholder : 1;
} lv_font_glyph_dsc_t;
typedef enum { LV_FONT_KERNING_NORMAL, LV_FONT_KERNING_NONE } lv_font_kerning_t;

struct lv_font_t {
    bool (*get_glyph_dsc)(const lv_font_t *, lv_font_glyph_dsc_t *, uint32_t, uint32_t);
    const void * (*get_glyph_bitmap)(lv_font_glyph_dsc_t *, lv_draw_buf_t *);
    void (*release_glyph)(const lv_font_t *, lv_font_glyph_dsc_t *);
    int32_t line_height;
    int32_t base_line;
    uint8_t subpx : 2;
    uint8_t kerning : 1;
    int8_t underline_position;
    int8_t underline_thickness;
    const void * dsc;
    const lv_font_t * fallback;
    void * user_data;
};

bool lv_font_get_glyph_dsc_fmt_txt(const lv_font_t *, lv_font_glyph_dsc_t *, uint32_t, uint32_t);
const void * lv_font_get_bitmap_fmt_txt(lv_font_glyph_dsc_t *, lv_draw_buf_t *);

#endif

#endif /* LVGL_STUB_H */

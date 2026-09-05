    .syntax unified
    .section .text.map_engine_load,"ax",%progbits
    .global map_engine_load
map_engine_load:
    bl  nds_open
    bx  lr
    .space 900
    .size map_engine_load, .-map_engine_load

    .section .data.map_cache_size,"aw",%progbits
    .global map_cache_size
map_cache_size:
    .word 4096
    .size map_cache_size, .-map_cache_size

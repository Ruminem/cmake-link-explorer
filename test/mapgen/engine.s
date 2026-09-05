    .syntax unified
    .section .text.engine_load,"ax",%progbits
    .global engine_load
engine_load:
    bl  store_open
    bx  lr
    .space 900
    .size engine_load, .-engine_load

    .section .data.cache_size,"aw",%progbits
    .global cache_size
cache_size:
    .word 4096
    .size cache_size, .-cache_size

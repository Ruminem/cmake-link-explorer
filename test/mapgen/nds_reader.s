    .syntax unified
    .section .text.nds_open,"ax",%progbits
    .global nds_open
nds_open:
    bx  lr
    .space 1500
    .size nds_open, .-nds_open

    .section .bss.nds_tile_buffer,"aw",%nobits
    .global nds_tile_buffer
nds_tile_buffer:
    .space 16384
    .size nds_tile_buffer, .-nds_tile_buffer

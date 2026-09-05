    .syntax unified
    .section .text.store_open,"ax",%progbits
    .global store_open
store_open:
    bx  lr
    .space 1500
    .size store_open, .-store_open

    .section .bss.store_buffer,"aw",%nobits
    .global store_buffer
store_buffer:
    .space 16384
    .size store_buffer, .-store_buffer

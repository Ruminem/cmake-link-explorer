    .syntax unified
    .section .text.never_called,"ax",%progbits
    .global never_called
never_called:
    bx  lr
    .space 700
    .size never_called, .-never_called

    .syntax unified
    .section .text.math_project,"ax",%progbits
    .global math_project
math_project:
    bx  lr
    .space 340
    .size math_project, .-math_project

    .section .rodata.math_table,"a",%progbits
    .global math_table
math_table:
    .space 512
    .size math_table, .-math_table

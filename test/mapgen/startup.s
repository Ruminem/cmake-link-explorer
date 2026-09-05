    .syntax unified
    .cpu cortex-m4
    .section .text.reset,"ax",%progbits
    .global Reset_Handler
Reset_Handler:
    bl  app_init
    bl  engine_load
    b   .
    .size Reset_Handler, .-Reset_Handler

    .section .text.vectors,"ax",%progbits
    .global vector_table
vector_table:
    .word 0x20010000
    .word Reset_Handler
    .space 120
    .size vector_table, .-vector_table

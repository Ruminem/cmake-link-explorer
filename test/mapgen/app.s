    .syntax unified
    .section .text.app_init,"ax",%progbits
    .global app_init
app_init:
    bl  math_project
    bl  store_open
    bx  lr
    .space 200
    .size app_init, .-app_init

    .section .rodata.app_banner,"a",%progbits
    .global app_banner
app_banner:
    .asciz "sample build"
    .space 100
    .size app_banner, .-app_banner

    .section .bss.app_state,"aw",%nobits
    .global app_state
app_state:
    .space 2048
    .size app_state, .-app_state

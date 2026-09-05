    .syntax unified
    .section .text.app_init,"ax",%progbits
    .global app_init
app_init:
    bl  geo_project
    bl  nds_open
    bx  lr
    .space 200
    .size app_init, .-app_init

    .section .rodata.app_banner,"a",%progbits
    .global app_banner
app_banner:
    .asciz "navi head unit build"
    .space 100
    .size app_banner, .-app_banner

    .section .bss.app_state,"aw",%nobits
    .global app_state
app_state:
    .space 2048
    .size app_state, .-app_state

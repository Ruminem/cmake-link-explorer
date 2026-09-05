MEMORY
{
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 512K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 128K
}
ENTRY(Reset_Handler)
SECTIONS
{
  .text : { KEEP(*(.text.vectors)) *(.text*) } > FLASH
  .rodata : { *(.rodata*) } > FLASH
  .data : { *(.data*) } > RAM AT> FLASH
  .bss : { *(.bss*) } > RAM
}

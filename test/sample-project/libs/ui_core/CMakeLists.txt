add_library(ui_core SHARED ui_core.cpp)
target_include_directories(ui_core PUBLIC .)
target_link_libraries(ui_core PUBLIC geo_utils)

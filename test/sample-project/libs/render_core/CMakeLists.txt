add_library(render_core SHARED render_core.cpp)
target_include_directories(render_core PUBLIC .)
target_link_libraries(render_core PUBLIC math_utils)

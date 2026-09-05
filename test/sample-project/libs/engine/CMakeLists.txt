add_library(engine STATIC engine.cpp)
target_include_directories(engine PUBLIC .)

target_link_libraries(engine PUBLIC store_reader math_utils)

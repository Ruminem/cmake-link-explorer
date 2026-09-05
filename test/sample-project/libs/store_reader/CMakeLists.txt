add_library(store_reader STATIC store_reader.cpp)
target_include_directories(store_reader PUBLIC .)

target_link_libraries(store_reader PUBLIC db_wrap)

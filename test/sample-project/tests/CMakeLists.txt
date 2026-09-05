add_executable(engine_test engine_test.cpp)
target_link_libraries(engine_test PRIVATE engine)

add_executable(store_test store_test.cpp)
target_link_libraries(store_test PRIVATE store_reader)

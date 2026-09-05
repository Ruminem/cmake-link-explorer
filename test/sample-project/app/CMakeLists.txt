add_executable(sample_app sample_app.cpp)
target_link_libraries(sample_app PRIVATE engine render_core log_wrapper)

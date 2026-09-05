#include "log_wrapper.h"
#include <cstdio>
namespace log_wrapper {
void Log(const char* context, const char* message) {
  std::printf("[%s] %s\n", context, message);
}
}  // namespace log_wrapper

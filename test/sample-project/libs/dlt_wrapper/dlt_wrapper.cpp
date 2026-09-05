#include "dlt_wrapper.h"
#include <cstdio>
namespace dlt_wrapper {
void Log(const char* context, const char* message) {
  std::printf("[%s] %s\n", context, message);
}
}  // namespace dlt_wrapper

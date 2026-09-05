#include "sqlite_wrap.h"
#include <string>
namespace sqlite_wrap {
int Open(const char* path) { return path && std::string(path).size() ? 1 : 0; }
}  // namespace sqlite_wrap

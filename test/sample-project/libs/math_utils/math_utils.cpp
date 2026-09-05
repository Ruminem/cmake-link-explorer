#include "math_utils.h"
namespace math_utils {
double Project(double latitude, double longitude) {
  return latitude * 111320.0 + longitude * 0.5;
}
}  // namespace math_utils

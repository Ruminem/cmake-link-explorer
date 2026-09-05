# CMake Link Explorer

CMake 프로젝트에서 링크 때문에 막히는 순간을 없애는 VS Code 익스텐션.

| 기능 | 답하는 질문 | 언제 쓰나 |
|---|---|---|
| **Link for include** | 이 헤더 쓰려면 **뭘 링크해야 하나** | `#include` 쓰고 막혔을 때 |
| **Targets** | 무엇이 무엇을 링크하나, 특히 **누가 이걸 링크하나** | 구조 파악, 영향 범위 |
| **Linker Map** | **뭐가 용량을 먹나**, 지난 빌드 대비 뭐가 늘었나 | 바이너리가 커졌을 때 |

# 설치

빌드도 패키징도 의존성도 없다. 순수 JavaScript라 클론해서 링크만 걸면 끝이다.

```
git clone https://github.com/Ruminem/cmake-link-explorer.git ~/cmake-link-explorer
mkdir -p ~/.vscode/extensions
ln -s ~/cmake-link-explorer ~/.vscode/extensions/cmake-link-explorer
```

VS Code를 **완전히 종료했다가** 다시 켠다. 확인:

```
code --list-extensions | grep cmake-link
```

`local.cmake-link-explorer` 가 뜨면 설치된 것이다. 테마나 아이콘 확장을 깐 것과
같은 상태이고, **클론한 폴더를 VS Code로 열어둘 필요는 없다.** 링크가 그 경로를
가리키므로 폴더를 옮기거나 지우지만 않으면 된다.

그다음부터는 CMake 프로젝트를 열거나 C/C++ 파일을 여는 것만으로 켜진다.
아이콘을 누를 필요도 없다.

업데이트는 `git pull` 하고 VS Code를 다시 켠다.

빌드 디렉토리는 `CMakeCache.txt`를 찾아 자동 탐지한다(3단계 깊이까지).
맵 파일도 빌드 디렉토리에서 `*.map`을 찾아 목록으로 띄운다.

## 익스텐션 자체를 고칠 때만: F5

이 저장소를 VS Code로 열고 `F5`를 누르면 익스텐션이 로드된 새 창이 뜬다.
코드를 고쳐가며 확인할 때만 쓰는 개발 모드이고, 그냥 쓰기만 할 거면 필요 없다.

---

# Link for include

가장 자주 막히는 지점이다.

> "이 헤더를 include해서 안에 있는 API를 쓰려는데,
>  CMakeLists.txt에 뭘 어떻게 링크해야 하는지 모르겠다."

`#include` 줄에 커서를 두면 **전구(Quick Fix)** 가 뜬다.

```cpp
#include "dlt_wrapper.h"     💡 Link dlt_wrapper from nds_test
```

누르면 알맞은 `CMakeLists.txt`를 찾아 고친다.

```cmake
target_link_libraries(nds_test PRIVATE nds_reader dlt_wrapper)
                                                  ^^^^^^^^^^^ 추가됨
```

기존 `target_link_libraries` 호출이 있으면 거기에 붙이고, 없으면
`add_library`/`add_executable` 바로 다음에 새로 만든다. 같은 파일의 다른
타겟은 건드리지 않는다.

**키워드는 어디서 include 했느냐로 정해진다.**

| include 위치 | 키워드 | 이유 |
|---|---|---|
| `.cpp` | `PRIVATE` | 남이 볼 일 없다 |
| `.h` / `.hpp` | `PUBLIC` | 이 타겟의 인터페이스가 된다. 소비자도 그 헤더를 보므로 의존성이 같이 따라가야 한다 |
| INTERFACE 라이브러리 | `INTERFACE` | 다른 선택지가 없다 |

헤더에서 include했는데 `PRIVATE`로 걸면 **여기선 컴파일되고 소비자 쪽에서
깨진다.** 같은 헤더라도 `.cpp`에서 부르면 `PRIVATE`, `.h`에서 부르면 `PUBLIC`.

## 네 가지 판정

| 상태 | 뜻 |
|---|---|
| **already-linked** | 직접 링크돼 있다. 그냥 쓰면 된다 |
| **transitive** | 다른 라이브러리를 거쳐서만 닿는다. **오늘은 컴파일되지만** 중간 라이브러리가 그걸 안 쓰게 되는 날 깨진다 |
| **needs-link** | 링크가 없다. 추가할 줄을 그대로 만들어준다 |
| **not-found** | 이 프로젝트의 어떤 타겟도 제공하지 않는다 |

`transitive`를 따로 구분하는 게 핵심이다. 빌드가 되니까 아무도 눈치 못 채다가
나중에 남의 커밋 때문에 깨지는 종류의 문제라서.

## 어떻게 찾나

헤더 → 타겟은 세 단계로 찾고, 신뢰도 순으로 보여준다.

1. **listed** — 타겟의 소스 목록에 그 헤더가 있다 (CMake가 아는 것, 확실)
2. **owned** — 헤더가 그 타겟의 소스 디렉토리 안에 있다
3. **nearby** — 그 이름의 파일이 타겟 디렉토리 아래 어딘가에 있다

파일이 속한 타겟은 CMake의 소스 목록에서 역으로 찾는다.

**한계 —** 헤더 전용 INTERFACE 라이브러리는 CMake 코드모델에 타겟으로 나오지
않아서 찾을 수 없다. abseil의 `absl::config` 같은 것들이 여기 해당한다.
그럴 땐 `not-found`라고 정직하게 말한다.

---

# Targets

```
TARGETS                     실행 파일이 먼저, 그다음 의존받는 순
🚀 navi_app          →3
📦 map_engine        →2 ←2      ← 펼치지 않아도 허브라는 게 보인다
📦 geo_utils            ←2      ← 아무것도 링크 안 하는 말단
📦 sqlite_wrap          ←1

▾ 📦 map_engine      →2 ←2
     → geo_utils     static           파랑 화살표 = 얘가 링크하는 것
     → nds_reader    static   →1
     ← map_test      exe              주황 화살표 = 얘를 링크하는 것
     ← navi_app      exe
```

행 하나에 양방향 개수가 다 들어 있다.

- `→`만 있다 = **최상위**, 아무도 안 쓴다 (보통 실행 파일)
- `←`만 있다 = **말단 라이브러리**, 깨지면 위험한 것
- 둘 다 크다 = **중간 허브**

펼치면 양방향이 한 번에 나온다. 폴더를 거치지 않으므로 클릭 한 번이면 된다.
자식을 계속 펼치면 그 방향으로만 체인을 따라간다.

### 맵을 열면 크기가 붙는다

Linker Map 탭에서 맵 파일을 열면, 같은 행에 **그 타겟이 바이너리에서 차지하는
크기**가 함께 나온다.

```
🚀 navi_app          →3        112 B
📦 nds_reader        →1 ←2     1.0 KB
📦 sqlite_wrap          ←1      277 B
📦 geo_utils            ←2              ← 이 이미지에 없음
📚 ui_core           →1 ←1     dynamic
```

CMake가 알려주는 `nameOnDisk`(`libnds_reader.a`)를 맵 파일의 이름과 맞춘다.
실행 파일은 CMake가 오브젝트를 `<타겟>.dir/`에 넣는 규칙으로 찾는다.

그래서 두 질문을 한 줄에서 같이 볼 수 있다.

- `nds_reader` — **2개만 쓰는데 1.0 KB**. 정리 후보
- `geo_utils` — **2개가 쓰는데 이미지에 없다.** `ui_core`가 셰어드 라이브러리라
  거기서 심볼이 해결된 것. 이런 건 맵을 직접 읽지 않으면 모른다
- `ui_core` — 동적 링크라 이미지에 없다. 임포트 스텁 몇십 바이트를 크기로
  표시하면 자릿수가 틀리므로 `dynamic`이라고만 쓴다

`sortTargets`를 `size`로 두면 **"쓰는 곳은 적은데 무거운 것"**을 위에서부터
찾을 수 있다. 바이너리 다이어트할 때 제일 먼저 하는 일이다.

## 어떻게 동작하나

CMakeLists.txt를 파싱하지 않는다. CMake의 **File API**(3.14+)를 쓴다.

빌드 디렉토리에 쿼리 파일을 하나 만들어 두면, CMake가 다음 configure 때
`.cmake/api/v1/reply/`에 **완전히 해석된 타겟 그래프를 JSON으로** 써준다.
제너레이터 표현식이나 조건부 링크를 직접 해석할 필요가 없다.

### 전이 축약 (transitive reduction)

File API의 `dependencies`는 **빌드 순서 기준 전이적 폐포**다. 실행 파일 하나가
결국 링크하게 되는 모든 라이브러리를 나열하기 때문에, 그대로 보여주면
`target_link_libraries`에 세 줄 적은 타겟이 50개를 링크하는 것처럼 보인다.

그래서 도달성을 보존하는 **최소 간선 집합**으로 줄여서 보여준다.
실측 (abseil-cpp, 타겟 121개):

| | |
|---|---|
| CMake가 보고한 간선 | 1,405개 |
| 축약 후 | 134개 (**90% 감소**) |
| `log_flags` 타겟 | 50개 → 3개 |

**주의 —** 축약된 그래프는 "링크 구조의 최소 형태"지 "`target_link_libraries`에
적힌 목록"이 아니다.

- A가 B와 C를 명시적으로 링크하는데 B도 C를 링크하면, `A → C` 간선은 숨는다
- 헤더 전용 INTERFACE 라이브러리는 CMake 코드모델에 타겟으로 나오지 않으므로
  애초에 표시되지 않는다 (abseil 같은 프로젝트에서 흔하다)

전체를 보려면 `showTransitiveDependencies`를 켜면 된다. 툴팁에는 항상
`links: 3 (50 including transitive)` 형태로 양쪽 개수가 함께 나온다.

## 기능

- 행의 `→n ←n` — 펼치지 않고도 보이는 양방향 개수
- 정렬은 기본이 **구조순** (실행 파일 → 의존받는 개수순). `sortTargets`로 알파벳순 전환
- `external` — 프로젝트 밖에서 오는 라이브러리 (하나로 묶어 맨 아래)
- 타겟 클릭 → `add_library`/`add_executable` 줄로 점프
- **Find Target** — 이름으로 찾기
- **Why Is This Linked?** — 두 타겟 사이 최단 의존 경로를 한 홉씩 추적
- CMake 재구성 시 자동 갱신

---

# Linker Map

```
LINKER MAP  navicore.map          gnu-ld · 21.8 KB
├── memory regions
│   ├── FLASH        3.6 KB / 512.0 KB    0.71%
│   └── RAM         18.0 KB / 128.0 KB     14.1%
├── by object                              21.8 KB total
│   ├── nds_reader.o  (libnavicore.a)     17.5 KB   80.2%
│   │   ├── .bss                          16.0 KB   91.5%
│   │   └── .text                          1.5 KB    8.4%
│   └── app.o                              2.4 KB   10.8%
├── by section
├── largest symbols
└── why archive members were pulled in
    └── geo_utils.o        ← app.o  (geo_project)
```

## 지원 포맷

| | 생성 방법 | 상태 |
|---|---|---|
| **GNU ld** | `-Wl,-Map=out.map` | 실제 `arm-none-eabi-ld` 출력으로 검증 |
| **Apple ld64** | `-Wl,-map,out.map` | 실제 Xcode 링커 출력으로 검증 |
| LLVM lld | `--Map=` | **미지원** |

lld는 일부러 넣지 않았다. 실물 샘플 없이 포맷을 추측해서 넣으면 조용히 틀린
숫자를 보여주게 된다. 샘플이 생기면 그때 추가한다.

포맷은 파일 내용으로 자동 감지한다. 맵 파일이 아니면 오해석하지 않고 거절한다.

## GNU ld 파싱에서 신경 쓴 것

- **줄바꿈된 섹션 이름** — 이름이 길면 GNU ld가 주소/크기를 다음 줄로 넘긴다.
  `.text.map_engine_load` 같은 게 전부 여기 해당해서, 이걸 놓치면 실제 임베디드
  맵의 상당 부분이 통째로 누락된다
- **아카이브 멤버** — `libfoo.a(bar.o)`를 아카이브와 오브젝트로 분리
- **`Archive member included` 표** — 각 아카이브 멤버가 **왜** 들어왔는지
  (어떤 오브젝트가 어떤 심볼을 참조해서). Targets 탭의 "Why Is This Linked?"와
  같은 질문에 대한 링커 수준의 답이다
- **`Discarded input sections`** — `--gc-sections`로 잘려나간 것들. 이미지 크기
  집계에서는 빼되 따로 보여준다
- **메모리 영역** — `Memory Configuration` 표를 읽어 FLASH/RAM 사용률을 계산.
  주소 기준으로 배치하므로 `AT>`로 LMA만 FLASH인 `.data`는 RAM 쪽에 잡힌다
- **심볼 vs 링커 스크립트 대입** — `. = ALIGN(4)` 같은 줄은 심볼이 아니다

## C++ 심볼 디맹글링

맵 파일의 심볼은 맹글링돼 있어서, 정작 이 기능이 제일 필요한 C++ 프로젝트에서
읽을 수가 없다. 심볼 전체를 `c++filt`에 한 번에 흘려보내 디맹글한다.

```
__ZNSt3__111__introsortINS_17_ClassicAlgPolicyERNS_6__lessIvEE...
  ↓
std::__1::__introsort<std::__1::_ClassicAlgPolicy, ...>(...)
```

툴체인이 다르면 `demanglerCommand`를 바꾸면 된다 (`arm-none-eabi-c++filt` 등).
디맹글러가 없으면 조용히 원래 이름을 쓴다.

## Diff

**Compare Two Map Files**로 두 빌드를 비교한다. 오브젝트별·섹션별로 무엇이
얼마나 늘고 줄었는지, 변화량 큰 순으로 정렬해서 보여준다. 안 바뀐 항목은 뺀다.

```
DIFF
├── total          44.1 KB → 13.5 KB   -30.5 KB
├── by object
└── by section
    ├── __text     -28.4 KB    40.2 KB → 11.8 KB
    └── __got        -288 B       648 B → 360 B
```

---

# 설정

| 키 | 기본값 | 설명 |
|---|---|---|
| `cmakeLinkExplorer.buildDirectory` | `""` | 빌드 디렉토리. 비우면 자동 탐지 |
| `cmakeLinkExplorer.configuration` | `""` | 멀티 컨피그에서 볼 구성 (Debug/Release) |
| `cmakeLinkExplorer.showUtilityTargets` | `false` | UTILITY 타겟 표시 |
| `cmakeLinkExplorer.showExternalLibraries` | `true` | 외부 라이브러리 표시 |
| `cmakeLinkExplorer.showTransitiveDependencies` | `false` | 축약하지 않고 전체 폐포 표시 |
| `cmakeLinkExplorer.sortTargets` | `structure` | `structure` = 실행 파일 먼저, 그다음 의존받는 순 / `size` = 이미지 기여 크기순 (맵 필요) / `name` = 알파벳순 |
| `cmakeLinkExplorer.demangleSymbols` | `true` | C++ 심볼 디맹글링 |
| `cmakeLinkExplorer.demanglerCommand` | `c++filt` | 사용할 디맹글러 |
| `cmakeLinkExplorer.mapSymbolLimit` | `200` | 표시할 최대 심볼 수 |

# 테스트

생성물부터 만든다 (`test/fixture/`와 `test/sample-project/build/`는 커밋되지 않는다):

```
./test/bootstrap.sh
```

그다음:

```
node test/run.js                                  합성 File API 픽스처
node test/run.js $PWD/test/sample-project/build   실제 CMake 빌드 트리
node test/run.js /path/to/any/build               아무 CMake 프로젝트나
node test/tree-test.js                            타겟 트리 렌더링
node test/map-test.js                             맵 파서 + 맵 트리
node test/map-test.js /path/to/x.map              맵 파일 하나 뜯어보기
node test/include-test.js                         include -> 링크 해결 + CMakeLists 편집
```

실제 VS Code 확장 호스트 안에서 (활성화, 명령 등록, 트리, 에디터 점프, 맵 탭):

```
CMAKE_LINK_TEST_LOG=/tmp/it.log \
"/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/test/integration" \
  --disable-extensions "$PWD/test/sample-project"
cat /tmp/it.log
```

확장 호스트는 stdout으로 로그를 넘기지 않으므로 `CMAKE_LINK_TEST_LOG`로 받는다.

`test/maps/`의 맵 파일은 진짜 링커가 만든 것이고 커밋돼 있어서, 툴체인 없이도
테스트가 돈다. 다시 만들려면 `test/mapgen/generate.sh` (GNU ld 부분은
`brew install arm-none-eabi-binutils` 필요).

## 검증 현황

| 대상 | |
|---|---|
| 합성 File API 픽스처 | 19 checks |
| `test/sample-project` (실제 CMake 4.4) | 17 checks |
| googletest / abseil-cpp (121 타겟) | 8 checks |
| 타겟 트리 렌더링 | 15 checks |
| 맵 파서 + 맵 트리 + 타겟 조인 | 46 checks |
| include → 링크 해결 + CMakeLists 편집 | 28 checks |
| VS Code 확장 호스트 (1.136) | 35 checks |

# 앞으로

- LLVM lld 맵 포맷 (실물 샘플이 생기면)
- 그래프 뷰 (웹뷰 + 노드 드래그)
- 순환 의존 / 미사용 타겟 표시

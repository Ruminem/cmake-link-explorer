# CMake Link Explorer

C++ 빌드의 **연결 구조와 크기**를 VS Code 안에서 보는 익스텐션. 탭 두 개다.

| 탭 | 답하는 질문 |
|---|---|
| **Targets** | 무엇이 무엇을 링크하나 — 특히 **누가 이 타겟을 링크하나** |
| **Linker Map** | 그래서 **뭐가 용량을 먹나**, 그리고 지난 빌드 대비 뭐가 늘었나 |

둘 다 CMakeLists.txt나 빌드 로그를 뒤져서는 답이 안 나오는 것들이다.

---

# Targets

```
TARGETS
├── navi_app                exe
│   ├── links →             3
│   │   ├── dlt_wrapper     static
│   │   ├── map_engine      static
│   │   └── ui_core         shared
│   └── external            3
│       ├── -lsqlite3
│       ├── -ldlt
│       └── -lpthread
└── geo_utils               static
    └── linked by ←         2
        ├── map_engine      static
        └── ui_core         shared
```

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

- `links →` / `linked by ←` — 노드를 펼치면 그 방향으로 체인을 따라간다
- `external` — 프로젝트 밖에서 오는 라이브러리
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

# 설치

빌드 단계가 없다. 의존성도 없다.

1. 이 폴더를 VS Code로 연다
2. `F5` — 익스텐션이 켜진 새 창이 뜬다
3. 새 창에서 C++ 프로젝트를 연다
4. 활동 표시줄의 **CMake Links** 아이콘

빌드 디렉토리는 `CMakeCache.txt`를 찾아 자동 탐지한다(3단계 깊이까지).
맵 파일도 빌드 디렉토리에서 `*.map`을 찾아 목록으로 띄운다.

상시 사용하려면:

```
ln -s "$(pwd)" ~/.vscode/extensions/cmake-link-explorer
```

# 설정

| 키 | 기본값 | 설명 |
|---|---|---|
| `cmakeLinkExplorer.buildDirectory` | `""` | 빌드 디렉토리. 비우면 자동 탐지 |
| `cmakeLinkExplorer.configuration` | `""` | 멀티 컨피그에서 볼 구성 (Debug/Release) |
| `cmakeLinkExplorer.showUtilityTargets` | `false` | UTILITY 타겟 표시 |
| `cmakeLinkExplorer.showExternalLibraries` | `true` | 외부 라이브러리 표시 |
| `cmakeLinkExplorer.showTransitiveDependencies` | `false` | 축약하지 않고 전체 폐포 표시 |
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
| 타겟 트리 렌더링 | 12 checks |
| 맵 파서 + 맵 트리 (GNU ld, ld64 실측) | 37 checks |
| VS Code 확장 호스트 (1.136) | 26 checks |

# 앞으로

- LLVM lld 맵 포맷 (실물 샘플이 생기면)
- 그래프 뷰 (웹뷰 + 노드 드래그)
- 맵의 오브젝트 ↔ Targets 탭의 CMake 타겟 연결
- 순환 의존 / 미사용 타겟 표시

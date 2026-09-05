# CMake Link Explorer

CMake 타겟의 **링크 구조를 양방향으로** 보여주는 VS Code 익스텐션.

CMakeLists.txt를 읽어서는 알 수 없는 것 — **"누가 이 타겟을 링크하고 있나"** — 를 보는 게 목적이다.

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
익스텐션은 그 JSON만 읽는다. 그래서 제너레이터 표현식, 조건부 링크,
`if()` 분기 같은 걸 직접 해석할 필요가 없다 — 이미 CMake가 다 계산한 결과다.

## 설치

빌드 단계가 없다. 의존성도 없다.

1. 이 폴더를 VS Code로 연다
2. `F5` — 익스텐션이 켜진 새 창(Extension Development Host)이 뜬다
3. 새 창에서 C++ 프로젝트를 연다
4. 활동 표시줄의 **CMake Links** 아이콘

빌드 디렉토리는 워크스페이스에서 `CMakeCache.txt`를 찾아 자동 탐지한다
(3단계 깊이까지). 못 찾거나 여러 개면 **Select build directory**로 지정.

File API 리플라이가 아직 없으면 configure를 한 번 돌리라고 안내한다.
버튼을 누르면 터미널에서 `cmake <build-dir>`를 실행한다.

상시 사용하려면 `~/.vscode/extensions/`에 심볼릭 링크를 걸면 된다:

```
ln -s "$(pwd)" ~/.vscode/extensions/cmake-link-explorer
```

## 기능

| | |
|---|---|
| `links →` | 이 타겟이 링크하는 것 |
| `linked by ←` | **이 타겟을 링크하는 것** (CMakeLists로는 못 보는 정보) |
| `external` | 프로젝트 밖에서 오는 라이브러리 (시스템 라이브러리, 프레임워크) |

- 노드를 계속 펼치면 그 방향으로 체인을 따라간다
- 타겟 클릭 → 그 타겟을 정의한 `CMakeLists.txt`의 `add_library`/`add_executable` 줄로 점프
- **Find Target** (`$(search)`) — 이름으로 찾아 트리에서 선택
- **Why Is This Linked?** — 두 타겟을 고르면 최단 의존 경로를 추적한다.
  "왜 navi_app이 sqlite_wrap을 끌고 오지?"에 답하는 기능
- CMake가 재구성되면 리플라이 파일을 감시해 자동 갱신

## 설정

| 키 | 기본값 | 설명 |
|---|---|---|
| `cmakeLinkExplorer.buildDirectory` | `""` | 빌드 디렉토리. 비우면 자동 탐지 |
| `cmakeLinkExplorer.configuration` | `""` | 멀티 컨피그 제너레이터에서 볼 구성 (Debug/Release) |
| `cmakeLinkExplorer.showUtilityTargets` | `false` | UTILITY 타겟 표시 (ALL_BUILD, ZERO_CHECK 등 노이즈) |
| `cmakeLinkExplorer.showExternalLibraries` | `true` | 외부 라이브러리 표시 |

## 테스트

CMake 없이 파서만 검증:

```
python3 test/make-fixture.py    # 합성 File API 리플라이 생성
node test/run.js               # 파싱 + 역방향 인덱스 + 경로 추적 검증
```

실제 CMake 출력으로 검증 (cmake 필요):

```
cmake -S test/sample-project -B /tmp/navi-build
mkdir -p /tmp/navi-build/.cmake/api/v1/query/client-cmake-link-explorer
touch /tmp/navi-build/.cmake/api/v1/query/client-cmake-link-explorer/codemodel-v2
cmake /tmp/navi-build
node test/run.js /tmp/navi-build
```

`test/sample-project`은 라이브러리 7개가 서로 얽힌 작은 C++ 프로젝트로,
`geo_utils`처럼 여러 곳에서 링크되는 타겟이 있어 역방향 뷰를 확인할 수 있다.

## 앞으로

- 그래프 뷰 (웹뷰 + 노드 드래그)
- 링커 맵 파일 탭 — 심볼별 크기, 빌드 간 diff
- 순환 의존 / 미사용 타겟 표시

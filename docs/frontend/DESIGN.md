# VKO ops UI — design direction

## Product cognition

- **Пользователь:** оперативный специалист школы, района, области, провайдера или администратор.
- **Главная задача:** понять, какие линии требуют внимания, открыть доказательства и выполнить следующий шаг.
- **Объект:** интернет-линия во времени; школа и устройство — контекст наблюдения.
- **Язык:** русский; технические identifiers и raw evidence находятся во вторичном слое.
- **Темперамент:** спокойный диспетчерский инструмент: плотный, контрастный, объяснимый, без маркетингового hero.

## Tokens

- Canvas `#08131f`, surface `#102234`, raised `#142b40`, border `#254158`.
- Text `#eaf4f6`, muted `#91aab2`, cyan `#79e4d0` (healthy), amber `#f5bd65` (attention), coral `#f47c78` (critical), blue `#7bb7ff` (neutral).
- Display/body: Georgia for the short wordmark only; system sans (`Inter`, `Segoe UI`, sans-serif) for all operational copy and numbers.
- Spacing rhythm: 4/8/12/16/24/32px. Corners 10px for cards, 999px for status pills.

## Signature

The map uses a restrained aurora gradient and thin signal arcs to make geography feel like a live monitoring surface. It stays subordinate to the current situation list and line evidence.

## UX rules

- Put a human conclusion and next action before raw metrics.
- Keep baseline quality and contract orientation as separate visual axes.
- Show `Нет актуальных данных` separately from `Нет соединения`.
- Every destructive or externally visible action needs confirmation and a visible audit result.
- Prefer a drawer/detail view over navigating away from the operational list.

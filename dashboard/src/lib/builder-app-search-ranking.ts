export type SearchableToolkit = {
  name: string;
  slug: string;
  description: string;
};

const STRONG_MATCH_SCORE = 800;

export function scoreToolkitRelevance(
  toolkit: SearchableToolkit,
  query: string,
  recommendedSlugs: string[],
): number {
  const normalizedQuery = query.trim().toLowerCase();
  const slug = toolkit.slug.trim().toLowerCase();
  const name = toolkit.name.trim().toLowerCase();
  const recommended = recommendedSlugs.map((value) => value.trim().toLowerCase());
  const recommendedIndex = recommended.indexOf(slug);

  if (!normalizedQuery) {
    if (recommendedIndex >= 0) return 1000 - recommendedIndex;
    return 1;
  }

  let score = 0;
  if (slug === normalizedQuery || name === normalizedQuery) score = 1000;
  else if (slug.startsWith(normalizedQuery) || name.startsWith(normalizedQuery)) score = 900;
  else if (slug.includes(normalizedQuery) || name.includes(normalizedQuery)) score = STRONG_MATCH_SCORE;
  else if (toolkit.description.trim().toLowerCase().includes(normalizedQuery)) score = 100;

  if (recommendedIndex >= 0) score += 50 - recommendedIndex;
  return score;
}

export function filterAndRankToolkitSearch<T extends SearchableToolkit>(
  toolkits: T[],
  query: string,
  recommendedSlugs: string[],
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  const scored = toolkits
    .map((toolkit) => ({
      toolkit,
      score: scoreToolkitRelevance(toolkit, normalizedQuery, recommendedSlugs),
    }))
    .filter(({ score }) => score > 0);

  const visible = normalizedQuery && scored.some(({ score }) => score >= STRONG_MATCH_SCORE)
    ? scored.filter(({ score }) => score >= STRONG_MATCH_SCORE)
    : scored;

  return visible
    .sort((left, right) => right.score - left.score || left.toolkit.name.localeCompare(right.toolkit.name))
    .map(({ toolkit }) => toolkit);
}

import { getGoals } from "@/lib/goals";
import GoalPicker from "@/app/_components/GoalPicker";

// Reads goals/*.md from the filesystem at request time — must not be statically
// prerendered at build (where goals/ is absent), or the dropdown bakes in empty.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const goals = await getGoals();
  const goalOptions = goals.map((g) => ({ id: g.id, title: g.title }));

  return (
    <main className="home-page">
      <h1>Reporting Agent</h1>
      <p>Select a report type to begin. The AI will interview you and draft the report.</p>
      <GoalPicker goals={goalOptions} />
    </main>
  );
}

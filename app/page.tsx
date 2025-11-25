import styles from './page.module.css';

export default function Page() {
  const card = (href: string, title: string, desc: string) => (
    <a href={href} className={styles.card}>
      <div className={styles.cardTitle}>{title}</div>
      <div className={styles.cardDescription}>{desc}</div>
    </a>
  );

  return (
    <main className={styles.container}>
      <h1 className={styles.title}>Universal Data Migrator</h1>
      <p className={styles.description}>Select a section to get started with your data migration journey</p>
      <div className={styles.cardGrid}>
        {card('/workflow', 'Workflow', 'Design and manage your data migration workflows')}
        {card('/logs', 'Logs', 'Track migration history and download detailed logs')}
        {card('/scheduling', 'Scheduling', 'Set up automated migration schedules')}
        {card('/query', 'Query', 'Execute and test SQL queries across databases')}
      </div>
    </main>
  );
}
export default function Page() {
  const card = (href:string, title:string, desc:string) => (
    <a href={href} style={{display:'block', padding:16, border:'1px solid #e5e7eb', borderRadius:12, minWidth:260, boxShadow:'0 1px 3px rgba(0,0,0,0.06)'}}>
      <div style={{fontWeight:700, marginBottom:6}}>{title}</div>
      <div style={{color:'#555'}}>{desc}</div>
    </a>
  );
  return (
    <main>
      <h1 style={{fontSize:24, fontWeight:700, marginBottom:12}}>Welcome</h1>
      <p style={{color:'#444', marginBottom:16}}>Pick a section:</p>
      <div style={{display:'flex', gap:16, flexWrap:'wrap'}}>
        {card('/workflow', 'Workflow', 'Design & run migrations')}
        {card('/logs', 'Logs', 'View past runs & download logs')}
        {card('/scheduling', 'Scheduling', 'Create recurring jobs')}
      </div>
    </main>
  );
}
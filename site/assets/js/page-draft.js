/**
 * Draft War Room -- a self-contained fantasy draft-day board and pick
 * tracker. Unlike every other page on this site, this one has nothing to do
 * with the handicapping model: no D1/Worker calls, no games/teams/players
 * data. Everything lives in memory + localStorage, entirely client-side, so
 * it works offline at the kitchen table during an actual draft.
 *
 * State shape:
 *   settings: { teams, mySlot, scoring, draftType, roster: {QB,RB,WR,TE,FLEX,DST,K,BENCH}, auctionBudget }
 *   players:  [{ id, name, pos, posRank, team, bye, tier, rank, espnRank, valueSignal, flags: [] }]
 *             (rank/tier/posRank/bye come from blending FantasyPros' 2026 PPR
 *             consensus board with ESPN's own 2026 projected-points ranking --
 *             see the SEED_PLAYERS comment below for what each field means and
 *             where the value/trap flags come from)
 *   picks:    [{ overall, playerId, owner: 'me'|'other', paid?: number }], in the order they were made
 *   ui:       { posFilter, search, hideDrafted, activeTab }
 *
 * `picks` is append-only and IS the source of truth for "whose turn is it" --
 * the current overall pick number is always picks.length + 1. Nothing else
 * (my roster, the run tracker, the strategy nudges) is stored separately;
 * it's all derived fresh from players+picks+settings on every render. That
 * makes "Reset draft" and "Undo" trivial (just mutate `picks`) instead of
 * needing to keep three data structures in sync by hand.
 */
(function () {
  "use strict";

  const ROSTER_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "DST", "K", "BENCH"];
  const DEFAULT_ROSTER = { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, DST: 1, K: 1, BENCH: 6 };
  const POSES = ["ALL", "QB", "RB", "WR", "TE", "DST", "K"];

  // Flag -> [badge class, label]. Badge colors reuse the site's existing
  // positive/negative/neutral/warn vocabulary rather than inventing new ones.
  const FLAG_META = {
    anchor: ["positive", "anchor"],
    value: ["positive", "value"],
    injury: ["warn", "injury risk"],
    trap: ["negative", "⚠ sexy pick"],
    rookie: ["neutral", "rookie"],
    handcuff: ["neutral", "handcuff"],
  };

  // Starter board: two independent 2026 rankings averaged together.
  //   1) FantasyPros' 2026 PPR Draft Rankings -- consensus of 100 experts,
  //      snapshotted Sep 1, 2026 (507-player/DST/K board -- FantasyPros'
  //      page stopped loading past rank 507 on the refresh, so the very
  //      deepest bench/kicker tier is missing, but that's ~300 players
  //      past what a 12-team league ever drafts -- with each player's own
  //      FantasyPros tier and ECR-vs-ADP delta).
  //   2) ESPN's 2026 Projected Stats rankings (season-long algorithmic FPTS
  //      projection, not a consensus/ADP board) from their default Pre-Draft
  //      Rankings, snapshotted Sep 1, 2026 -- covers their top 300 overall.
  // overallRank/posRank below are the BLENDED order: each player's FantasyPros
  // rank and ESPN rank are averaged (players outside ESPN's top 300 just keep
  // their FantasyPros rank), then the whole board is re-sorted and re-numbered
  // from that average. Tier stays FantasyPros' own expert-assigned grouping
  // (a qualitative label, not recomputed from the blended number).
  // Each row is [overallRank, name, pos, posRank, team, bye, tier, valueSignal, espnRank]:
  //   bye                bye week, or null where FantasyPros shows none (free
  //                      agents with no current team).
  //   espnRank           this player's rank in ESPN's own top-300 board, or
  //                      null if they didn't rank him at all.
  //   valueSignal        blend of FantasyPros' own ECR-vs-ADP delta with the
  //                      FantasyPros-rank-minus-ESPN-rank gap (when ESPN has
  //                      him): positive = the field/ADP OR ESPN's own points
  //                      projection likes this player better than the other
  //                      signal does (a value/"falls to you" signal); negative
  //                      = the market is chasing name value ahead of where
  //                      either signal thinks he belongs (the "sexy pick"
  //                      signal). null means neither signal had enough to go
  //                      on.
  // This is a snapshot, not a live feed -- ADP drifts all preseason, so
  // re-import a fresh cheat-sheet CSV close to draft day (see the import note
  // above) if it's been more than a couple weeks since Sep 1, 2026.
  // prettier-ignore
  const SEED_PLAYERS = [
    [1,"Jahmyr Gibbs","RB",1,"DET",6,1,0,1],
    [2,"Ja'Marr Chase","WR",1,"CIN",6,1,0,3],
    [3,"Bijan Robinson","RB",2,"ATL",11,1,0,2],
    [4,"Puka Nacua","WR",2,"LAR",11,1,0,4],
    [5,"Jaxon Smith-Njigba","WR",3,"SEA",11,1,0,6],
    [6,"Amon-Ra St. Brown","WR",4,"DET",6,1,0,8],
    [7,"Jonathan Taylor","RB",3,"IND",13,2,1,5],
    [8,"Christian McCaffrey","RB",4,"SF",8,2,-1,7],
    [9,"CeeDee Lamb","WR",5,"DAL",14,2,0,11],
    [10,"Justin Jefferson","WR",6,"MIN",6,2,0,12],
    [11,"James Cook III","RB",5,"BUF",7,3,0,9],
    [12,"Drake London","WR",7,"ATL",11,2,2,17],
    [13,"Chase Brown","RB",6,"CIN",6,3,0,14],
    [14,"De'Von Achane","RB",7,"MIA",6,3,0,10],
    [15,"A.J. Brown","WR",8,"NE",11,3,0,19],
    [16,"Nico Collins","WR",9,"HOU",8,3,0,23],
    [17,"Trey McBride","TE",1,"ARI",14,3,2,20],
    [18,"Saquon Barkley","RB",8,"PHI",10,4,0,15],
    [19,"Omarion Hampton","RB",9,"LAC",7,4,1,13],
    [20,"Chris Olave","WR",10,"NO",8,3,1,24],
    [21,"Brock Bowers","TE",2,"LV",13,3,0,22],
    [22,"George Pickens","WR",11,"DAL",14,3,-2,28],
    [23,"Ashton Jeanty","RB",10,"LV",13,4,0,18],
    [24,"Kenneth Walker III","RB",11,"KC",5,4,-4,25],
    [25,"Josh Allen","QB",1,"BUF",7,4,-2,26],
    [26,"Rashee Rice","WR",12,"KC",5,4,0,27],
    [27,"Derrick Henry","RB",12,"BAL",13,5,0,16],
    [28,"DeVonta Smith","WR",13,"PHI",10,3,-2,35],
    [29,"Malik Nabers","WR",14,"NYG",8,4,-3,33],
    [30,"Garrett Wilson","WR",15,"NYJ",13,4,5,29],
    [31,"Jeremiyah Love","RB",13,"ARI",14,5,4,21],
    [32,"Zay Flowers","WR",16,"BAL",13,4,-1,37],
    [33,"Breece Hall","RB",14,"NYJ",13,5,2,30],
    [34,"Tetairoa McMillan","WR",17,"CAR",5,4,1,36],
    [35,"Ladd McConkey","WR",18,"LAC",7,4,2,40],
    [36,"Kyren Williams","RB",15,"LAR",11,5,-2,32],
    [37,"Javonte Williams","RB",16,"DAL",14,5,0,31],
    [38,"Colston Loveland","TE",3,"CHI",10,5,-1,42],
    [39,"Jaylen Waddle","WR",19,"DEN",10,4,0,45],
    [40,"Lamar Jackson","QB",2,"BAL",13,4,-6,48],
    [41,"Tee Higgins","WR",20,"CIN",6,5,-1,43],
    [42,"Emeka Egbuka","WR",21,"TB",10,5,2,38],
    [43,"Travis Etienne Jr.","RB",17,"NO",8,5,0,34],
    [44,"Davante Adams","WR",22,"LAR",11,5,3,44],
    [45,"Drake Maye","QB",3,"NE",11,5,-3,58],
    [46,"D'Andre Swift","RB",18,"CHI",10,5,-1,46],
    [47,"Cam Skattebo","RB",19,"NYG",8,6,-2,41],
    [48,"Terry McLaurin","WR",23,"WAS",7,5,2,51],
    [49,"Quinshon Judkins","RB",20,"CLE",11,6,3,39],
    [50,"DJ Moore","WR",24,"BUF",7,5,-2,52],
    [51,"Bucky Irving","RB",21,"TB",10,6,-1,49],
    [52,"Luther Burden III","WR",25,"CHI",10,5,-3,60],
    [53,"Tyler Warren","TE",4,"IND",13,6,-2,55],
    [54,"Jameson Williams","WR",26,"DET",6,6,2,54],
    [55,"Joe Burrow","QB",4,"CIN",6,5,-6,64],
    [56,"Jayden Daniels","QB",5,"WAS",7,6,2,57],
    [57,"David Montgomery","RB",22,"HOU",8,6,-1,50],
    [58,"Bhayshul Tuten","RB",23,"JAC",7,6,4,47],
    [59,"Rome Odunze","WR",27,"CHI",10,6,2,56],
    [60,"Jadarian Price","RB",24,"SEA",11,6,3,53],
    [61,"Mike Evans","WR",28,"SF",8,6,2,62],
    [62,"Jalen Hurts","QB",6,"PHI",10,6,-3,69],
    [63,"Carnell Tate","WR",29,"TEN",9,6,6,61],
    [64,"TreVeyon Henderson","RB",25,"NE",11,6,1,59],
    [65,"Christian Watson","WR",30,"GB",11,6,-4,75],
    [66,"Marvin Harrison Jr.","WR",31,"ARI",14,6,4,65],
    [67,"Rhamondre Stevenson","RB",26,"NE",11,7,2,63],
    [68,"Parker Washington","WR",32,"JAC",7,6,-6,76],
    [69,"Harold Fannin Jr.","TE",5,"CLE",11,7,-2,70],
    [70,"Michael Pittman Jr.","WR",33,"PIT",9,7,14,66],
    [71,"Jaylen Warren","RB",27,"PIT",9,7,-2,74],
    [72,"DK Metcalf","WR",34,"PIT",9,7,6,68],
    [73,"Dak Prescott","QB",7,"DAL",14,7,1,73],
    [74,"Kyle Pitts Sr.","TE",6,"ATL",11,7,0,72],
    [75,"Tony Pollard","RB",28,"TEN",9,7,5,67],
    [76,"Caleb Williams","QB",8,"CHI",10,6,-6,89],
    [77,"Justin Herbert","QB",9,"LAC",7,6,-2,86],
    [78,"Courtland Sutton","WR",35,"DEN",10,7,2,71],
    [79,"Sam LaPorta","TE",7,"DET",6,7,-4,81],
    [80,"Wan'Dale Robinson","WR",36,"TEN",9,7,10,80],
    [81,"Chris Godwin Jr.","WR",37,"TB",10,7,-4,97],
    [82,"Rico Dowdle","RB",29,"PIT",9,7,-2,83],
    [83,"Michael Wilson","WR",38,"ARI",14,7,1,84],
    [84,"Trevor Lawrence","QB",10,"JAC",7,7,-6,99],
    [85,"Jonathon Brooks","RB",30,"CAR",5,7,-3,87],
    [86,"George Kittle","TE",8,"SF",8,8,3,78],
    [87,"Kenny Gainwell","RB",31,"TB",10,8,10,77],
    [88,"Brian Thomas Jr.","WR",39,"JAC",7,7,-6,95],
    [89,"Stefon Diggs","WR",40,"WAS",7,7,5,88],
    [90,"Jaxson Dart","QB",11,"NYG",8,7,4,85],
    [91,"MarShawn Lloyd","RB",32,"GB",11,8,18,79],
    [92,"Tucker Kraft","TE",9,"GB",11,7,-17,104],
    [93,"Chuba Hubbard","RB",33,"CAR",5,8,0,90],
    [94,"Josh Downs","WR",41,"IND",13,7,7,105],
    [95,"Alec Pierce","WR",42,"IND",13,8,-1,93],
    [96,"Brock Purdy","QB",12,"SF",8,7,4,102],
    [97,"RJ Harvey","RB",34,"DEN",10,7,-12,109],
    [98,"Travis Kelce","TE",10,"KC",5,7,-7,107],
    [99,"Jakobi Meyers","WR",43,"JAC",7,8,14,94],
    [100,"J.K. Dobbins","RB",35,"DEN",10,8,-6,101],
    [101,"Jordan Addison","WR",44,"MIN",6,8,4,98],
    [102,"Bo Nix","QB",13,"DEN",10,7,-1,113],
    [103,"Patrick Mahomes II","QB",14,"KC",5,8,-1,108],
    [104,"Quentin Johnston","WR",45,"LAC",7,7,-8,120],
    [105,"Aaron Jones Sr.","RB",36,"MIN",6,8,14,92],
    [106,"Rachaad White","RB",37,"WAS",7,8,9,100],
    [107,"Makai Lemon","WR",46,"PHI",10,8,2,111],
    [108,"Matthew Stafford","QB",15,"LAR",11,8,-12,115],
    [109,"Blake Corum","RB",38,"LAR",11,8,-6,112],
    [110,"Kyle Monangai","RB",39,"CHI",10,8,0,103],
    [111,"Matthew Golden","WR",47,"GB",11,8,16,96],
    [112,"Jayden Reed","WR",48,"GB",11,8,0,121],
    [113,"Josh Jacobs","RB",40,"GB",11,9,-12,82],
    [114,"Kyler Murray","QB",16,"MIN",6,8,12,116],
    [115,"Khalil Shakir","WR",49,"BUF",7,8,20,106],
    [116,"Jake Ferguson","TE",11,"DAL",14,8,0,114],
    [117,"Dallas Goedert","TE",12,"PHI",10,8,0,110],
    [118,"Jacory Croskey-Merritt","RB",41,"WAS",7,8,-4,117],
    [119,"Jared Goff","QB",17,"DET",6,8,-2,129],
    [120,"Dalton Kincaid","TE",13,"BUF",7,8,-3,127],
    [121,"Isaiah Likely","TE",14,"NYG",8,8,-7,119],
    [122,"KC Concepcion","WR",50,"CLE",11,8,-4,133],
    [123,"Jordan Mason","RB",42,"MIN",6,8,-16,131],
    [124,"Jalen Coker","WR",51,"CAR",5,8,8,126],
    [125,"Romeo Doubs","WR",52,"NE",11,8,2,125],
    [126,"De'Zhaun Stribling","WR",53,"SF",8,9,-6,123],
    [127,"Xavier Worthy","WR",54,"KC",5,9,4,122],
    [128,"Tyler Shough","QB",18,"NO",8,8,12,128],
    [129,"Mark Andrews","TE",15,"BAL",13,9,2,124],
    [130,"Baker Mayfield","QB",19,"TB",10,8,0,138],
    [131,"Woody Marks","RB",43,"HOU",8,9,0,135],
    [132,"Tyjae Spears","RB",44,"TEN",9,9,7,130],
    [133,"Jordan Love","QB",20,"GB",11,8,-4,156],
    [134,"Deebo Samuel Sr.","WR",55,"SF",8,9,0,132],
    [135,"Juwan Johnson","TE",16,"NO",8,9,0,149],
    [136,"Chris Rodriguez Jr.","RB",45,"JAC",7,9,-4,144],
    [137,"Daniel Jones","QB",21,"IND",13,9,19,140],
    [138,"Zach Charbonnet","RB",46,"SEA",11,9,4,134],
    [139,"Jonah Coleman","RB",47,"DEN",10,9,11,137],
    [140,"Tyler Allgeier","RB",48,"ARI",14,9,-5,151],
    [141,"Travis Hunter","WR",56,"JAC",7,10,64,91],
    [142,"Malik Willis","QB",22,"MIA",6,8,0,168],
    [143,"Houston Texans","DST",1,"HOU",8,9,-20,141],
    [144,"Brandon Aubrey","K",1,"DAL",14,10,-10,118],
    [145,"Dylan Sampson","RB",49,"CLE",11,9,6,158],
    [146,"Rashid Shaheed","WR",57,"SEA",11,9,-8,163],
    [147,"Jalen McMillan","WR",58,"TB",10,10,34,136],
    [148,"Jordyn Tyson","WR",59,"NO",8,9,-12,169],
    [149,"Denver Broncos","DST",2,"DEN",10,10,-13,143],
    [150,"Hunter Henry","TE",17,"NE",11,9,3,150],
    [151,"Alvin Kamara","RB",50,"NO",8,10,6,147],
    [152,"Denzel Boston","WR",60,"CLE",11,9,2,164],
    [153,"Isiah Pacheco","RB",51,"DET",6,10,5,145],
    [154,"Brenton Strange","TE",18,"JAC",7,9,-3,160],
    [155,"Keaton Mitchell","RB",52,"LAC",7,9,-6,172],
    [156,"Tre Tucker","WR",61,"LV",13,9,2,170],
    [157,"Mike Washington Jr.","RB",53,"LV",13,9,-18,173],
    [158,"Adonai Mitchell","WR",62,"NYJ",13,10,34,166],
    [159,"Jerry Jeudy","WR",63,"CLE",11,10,8,165],
    [160,"Brian Robinson Jr.","RB",54,"ATL",11,10,3,159],
    [161,"T.J. Hockenson","TE",19,"MIN",6,10,6,153],
    [162,"Cameron Dicker","K",2,"LAC",7,10,-5,142],
    [163,"Tank Bigsby","RB",55,"PHI",10,10,-4,178],
    [164,"Sam Darnold","QB",23,"SEA",11,9,-8,201],
    [165,"C.J. Stroud","QB",24,"HOU",8,9,-10,200],
    [166,"Ka'imi Fairbairn","K",3,"HOU",8,10,-8,148],
    [167,"Braelon Allen","RB",56,"NYJ",13,10,13,174],
    [168,"Keenan Allen","WR",64,"IND",13,10,4,155],
    [169,"Jason Myers","K",4,"SEA",11,10,-6,146],
    [170,"Los Angeles Rams","DST",3,"LAR",11,10,-34,182],
    [171,"Seattle Seahawks","DST",4,"SEA",11,10,-28,181],
    [172,"Dontayvion Wicks","WR",65,"PHI",10,10,42,176],
    [173,"Calvin Ridley","WR",66,"TEN",9,10,18,157],
    [174,"Terrance Ferguson","TE",20,"LAR",11,10,20,162],
    [175,"Jalen Nailor","WR",67,"LV",13,10,16,171],
    [176,"Dalton Schultz","TE",21,"HOU",8,9,-16,207],
    [177,"Philadelphia Eagles","DST",5,"PHI",10,10,-22,184],
    [178,"Pittsburgh Steelers","DST",6,"PIT",9,10,-14,180],
    [179,"Jaylin Noel","WR",68,"HOU",8,10,57,161],
    [180,"Ray Davis","RB",57,"BUF",7,10,24,179],
    [181,"Tank Dell","WR",69,"HOU",8,11,23,139],
    [182,"Kenyon Sadiq","TE",22,"NYJ",13,11,9,154],
    [183,"Cam Ward","QB",25,"TEN",9,9,-2,219],
    [184,"Chig Okonkwo","TE",23,"WAS",7,9,-8,216],
    [185,"New England Patriots","DST",7,"NE",11,10,-16,186],
    [186,"Jauan Jennings","WR",70,"MIN",6,10,2,202],
    [187,"Kayshon Boutte","WR",71,"HOU",8,10,-7,211],
    [188,"Baltimore Ravens","DST",8,"BAL",13,10,-13,183],
    [189,"Harrison Mevis","K",5,"LAR",11,11,6,152],
    [190,"Bryce Young","QB",26,"CAR",5,10,6,218],
    [191,"Tre' Harris","WR",72,"LAC",7,10,16,205],
    [192,"Jacksonville Jaguars","DST",9,"JAC",7,10,-20,null],
    [193,"Los Angeles Chargers","DST",10,"LAC",7,10,-7,189],
    [194,"Ryan Flournoy","WR",73,"DAL",14,10,16,208],
    [195,"Omar Cooper Jr.","WR",74,"NYJ",13,10,8,210],
    [196,"Cam Little","K",6,"JAC",7,10,-22,192],
    [197,"Rashod Bateman","WR",75,"BAL",13,11,53,175],
    [198,"Eddy Pineiro","K",7,"SF",8,11,-4,190],
    [199,"Kansas City Chiefs","DST",11,"KC",5,11,11,188],
    [200,"Tyler Loop","K",8,"BAL",13,11,-6,194],
    [201,"Caleb Douglas","WR",76,"MIA",6,11,32,167],
    [202,"Jacoby Brissett","QB",27,"ARI",14,10,2,220],
    [203,"Malik Washington","WR",77,"MIA",6,10,0,224],
    [204,"Tyrone Tracy Jr.","RB",58,"NYG",8,10,-26,244],
    [205,"Jake Bates","K",9,"DET",6,11,-15,193],
    [206,"Detroit Lions","DST",12,"DET",6,11,-4,187],
    [207,"Kimani Vidal","RB",59,"LAC",7,10,16,213],
    [208,"Cairo Santos","K",10,"CHI",10,11,0,195],
    [209,"AJ Barner","TE",24,"SEA",11,10,-4,217],
    [210,"Emmett Johnson","RB",60,"KC",5,10,-26,240],
    [211,"Ja'Kobi Lane","WR",78,"BAL",13,11,-12,199],
    [212,"Gunnar Helm","TE",25,"TEN",9,11,32,215],
    [213,"Cleveland Browns","DST",13,"CLE",11,11,10,185],
    [214,"Devaughn Vele","WR",79,"NO",8,11,40,177],
    [215,"Pat Freiermuth","TE",26,"PIT",9,11,6,206],
    [216,"Germie Bernard","WR",80,"PIT",9,11,40,204],
    [217,"Harrison Butker","K",11,"KC",5,11,-7,191],
    [218,"Kaelon Black","RB",61,"SF",8,11,-7,212],
    [219,"Green Bay Packers","DST",14,"GB",11,11,-24,236],
    [220,"Malachi Fields","WR",81,"NYG",8,11,16,203],
    [221,"Zachariah Branch","WR",82,"ATL",11,11,18,209],
    [222,"Justice Hill","RB",62,"BAL",13,11,13,198],
    [223,"Pat Bryant","WR",83,"DEN",10,10,8,263],
    [224,"James Conner","RB",63,"ARI",14,11,-5,null],
    [225,"Cooper Kupp","WR",84,"SEA",11,11,-18,227],
    [226,"Najee Harris","RB",64,"NYG",8,11,22,197],
    [227,"Troy Franklin","WR",85,"DEN",10,11,68,null],
    [228,"Sean Tucker","RB",65,"TB",10,11,2,245],
    [229,"Jaylen Wright","RB",66,"MIA",6,11,20,214],
    [230,"Buffalo Bills","DST",15,"BUF",7,11,-38,null],
    [231,"Nicholas Singleton","RB",67,"TEN",9,11,-4,250],
    [232,"Andy Borregales","K",12,"NE",11,11,-17,null],
    [233,"Will Reichard","K",13,"MIN",6,12,-4,196],
    [234,"Chris Bell","WR",86,"MIA",6,11,10,232],
    [235,"Chase McLaughlin","K",14,"TB",10,11,-10,238],
    [236,"Evan McPherson","K",15,"CIN",6,11,-35,256],
    [237,"Aaron Rodgers","QB",28,"PIT",9,11,-14,269],
    [238,"Malik Davis","RB",68,"DAL",14,11,26,225],
    [239,"Isaac TeSlaa","WR",87,"DET",6,11,-10,262],
    [240,"Geno Smith","QB",29,"NYJ",13,11,56,267],
    [241,"Samaje Perine","RB",69,"CIN",6,12,30,222],
    [242,"Minnesota Vikings","DST",16,"MIN",6,10,-70,299],
    [243,"Ty Johnson","RB",70,"BUF",7,12,148,223],
    [244,"George Holani","RB",71,"SEA",11,11,14,243],
    [245,"Chris Boswell","K",16,"PIT",9,11,-14,237],
    [246,"Ollie Gordon II","RB",72,"MIA",6,12,92,221],
    [247,"Cade Otton","TE",27,"TB",10,11,-8,260],
    [248,"Antonio Williams","WR",88,"WAS",7,11,10,252],
    [249,"Chris Brooks","RB",73,"GB",11,12,16,239],
    [250,"Greg Dulcich","TE",28,"MIA",6,11,-22,258],
    [251,"Oronde Gadsden II","TE",29,"LAC",7,11,-35,291],
    [252,"Isaiah Davis","RB",74,"NYJ",13,12,198,241],
    [253,"Xavier Legette","WR",89,"CAR",5,12,132,228],
    [254,"Keon Coleman","WR",90,"BUF",7,11,18,261],
    [255,"LeQuint Allen Jr.","RB",75,"JAC",7,12,88,242],
    [256,"Darius Slayton","WR",91,"NYG",8,12,132,234],
    [257,"Jordan James","RB",76,"SF",8,12,-8,247],
    [258,"Darnell Mooney","WR",92,"NYG",8,11,4,294],
    [259,"Kaytron Allen","RB",77,"WAS",7,11,-14,277],
    [260,"Cyrus Allen","WR",93,"KC",5,12,-56,null],
    [261,"Chimere Dike","WR",94,"TEN",9,12,6,null],
    [262,"Elic Ayomanor","WR",95,"TEN",9,12,56,null],
    [263,"Emanuel Wilson","RB",78,"SEA",11,11,13,279],
    [264,"Brashard Smith","RB",79,"KC",5,12,55,226],
    [265,"Tyquan Thornton","WR",96,"KC",5,12,84,253],
    [266,"Fernando Mendoza","QB",30,"LV",13,12,-20,268],
    [267,"Jack Bech","WR",97,"LV",13,11,13,274],
    [268,"Seth McGowan","RB",80,"IND",13,12,24,246],
    [269,"Demond Claiborne","RB",81,"MIN",6,12,22,266],
    [270,"Colby Parkinson","TE",30,"LAR",11,12,41,null],
    [271,"Evan Engram","TE",31,"DEN",10,11,34,289],
    [272,"Kendre Miller","RB",82,"NO",8,12,37,251],
    [273,"Ted Hurst III","WR",98,"TB",10,12,5,284],
    [274,"David Njoku","TE",32,"LAC",7,11,-39,290],
    [275,"Wil Lutz","K",17,"DEN",10,12,-64,null],
    [276,"DeMario Douglas","WR",99,"NE",11,13,181,233],
    [277,"Mason Taylor","TE",33,"NYJ",13,12,14,null],
    [278,"Marvin Mims Jr.","WR",100,"DEN",10,12,16,264],
    [279,"Tory Horton","WR",101,"SEA",11,12,12,275],
    [280,"Kaleb Johnson","RB",83,"GB",11,12,-30,280],
    [281,"New Orleans Saints","DST",17,"NO",8,12,-2,255],
    [282,"Christian Kirk","WR",102,"SF",8,12,-16,null],
    [283,"Jahan Dotson","WR",103,"ATL",11,13,165,229],
    [284,"Deshaun Watson","QB",31,"CLE",11,12,58,270],
    [285,"Elijah Sarratt","WR",104,"BAL",13,12,75,null],
    [286,"Xavier Hutchinson","WR",105,"HOU",8,13,215,230],
    [287,"Atlanta Falcons","DST",18,"ATL",11,12,-42,null],
    [288,"Jalen Tolbert","WR",106,"MIA",6,13,154,231],
    [289,"Michael Penix Jr.","QB",32,"ATL",11,12,3,null],
    [290,"Darren Waller","TE",34,"CAR",5,13,76,259],
    [291,"Jaydon Blue","RB",84,"PHI",10,12,-47,null],
    [292,"DJ Giddens","RB",85,"IND",13,12,76,278],
    [293,"Kirk Cousins","QB",33,"LV",13,12,33,null],
    [294,"Tua Tagovailoa","QB",34,"ATL",11,12,-6,296],
    [295,"Theo Johnson","TE",35,"NYG",8,12,35,null],
    [296,"San Francisco 49ers","DST",19,"SF",8,12,-26,286],
    [297,"Will Shipley","RB",86,"PHI",10,13,150,248],
    [298,"Devin Neal","RB",87,"NO",8,12,44,null],
    [299,"Kyle Williams","WR",107,"NE",11,12,-30,null],
    [300,"Andrei Iosivas","WR",108,"CIN",6,13,71,271],
    [301,"Eli Stowers","TE",36,"PHI",10,12,-30,null],
    [302,"Tahj Brooks","RB",88,"CIN",6,13,124,265],
    [303,"Shedeur Sanders","QB",35,"CLE",11,12,-41,null],
    [304,"Mike Gesicki","TE",37,"CIN",6,12,35,292],
    [305,"Adam Randall","RB",89,"BAL",13,12,61,null],
    [306,"Hollywood Brown","WR",109,"PHI",10,12,24,null],
    [307,"Emari Demercado","RB",90,"FA",null,12,75,null],
    [308,"Mack Hollins","WR",110,"NE",11,12,184,295],
    [309,"Devin Singletary","RB",91,"NYG",8,12,-37,null],
    [310,"Indianapolis Colts","DST",20,"IND",13,13,-12,298],
    [311,"Tampa Bay Buccaneers","DST",21,"TB",10,14,26,235],
    [312,"Isaiah Bond","WR",111,"CLE",11,13,358,null],
    [313,"Skyler Bell","WR",112,"BUF",7,13,20,null],
    [314,"Michael Mayer","TE",38,"LV",13,13,107,293],
    [315,"Brandon Aiyuk","WR",113,"SF",8,13,-29,null],
    [316,"Jake Tonges","TE",39,"SF",8,13,-3,null],
    [317,"Trevor Etienne","RB",92,"CAR",5,13,347,null],
    [318,"Chicago Bears","DST",22,"CHI",10,13,-113,null],
    [319,"Trey Benson","RB",93,"ARI",14,13,1,null],
    [320,"Jerome Ford","RB",94,"WAS",7,13,241,null],
    [321,"Darnell Washington","TE",40,"PIT",9,13,-22,null],
    [322,"Dallas Cowboys","DST",23,"DAL",14,13,-54,297],
    [323,"Bam Knight","RB",95,"ARI",14,13,65,282],
    [324,"Audric Estime","RB",96,"NO",8,13,23,null],
    [325,"Isaac Guerendo","RB",97,"SF",8,13,257,null],
    [326,"Charlie Smyth","K",18,"FA",null,13,87,null],
    [327,"Jarquez Hunter","RB",98,"FA",null,13,82,null],
    [328,"Jaleel McLaughlin","RB",99,"FA",null,13,273,null],
    [329,"Kevin Coleman Jr.","WR",114,"MIA",6,14,198,272],
    [330,"Tyreek Hill","WR",115,"FA",null,13,-74,null],
    [331,"KaVontae Turpin","WR",116,"DAL",14,14,38,273],
    [332,"Charlie Kolar","TE",41,"LAC",7,13,179,null],
    [333,"Oscar Delp","TE",42,"NO",8,13,326,null],
    [334,"Trey Smack","K",19,"GB",11,14,-38,287],
    [335,"Elijah Arroyo","TE",43,"SEA",11,13,17,null],
    [336,"Nick Folk","K",20,"ATL",11,14,7,257],
    [337,"Bryce Lance","WR",117,"NO",8,13,149,null],
    [338,"Jacob Saylors","RB",100,"DET",6,14,164,249],
    [339,"Carson Beck","QB",36,"ARI",14,13,103,null],
    [340,"Cole Kmet","TE",44,"CHI",10,13,-40,null],
    [341,"Eli Raridon","TE",45,"NE",11,13,24,null],
    [342,"Tyler Higbee","TE",46,"LAR",11,13,5,null],
    [343,"Erick All Jr.","TE",47,"CIN",6,13,153,null],
    [344,"Dawson Knox","TE",48,"BUF",7,13,-14,null],
    [345,"Kendrick Bourne","WR",118,"ARI",14,13,327,null],
    [346,"Rasheen Ali","RB",101,"BAL",13,14,124,276],
    [347,"Cincinnati Bengals","DST",24,"CIN",6,14,-21,300],
    [348,"Kareem Hunt","RB",102,"FA",null,13,53,null],
    [349,"Tez Johnson","WR",119,"TB",10,13,121,null],
    [350,"Olamide Zaccheaus","WR",120,"ATL",11,13,291,null],
    [351,"Spencer Shrader","K",21,"IND",13,14,6,288],
    [352,"Jalen Royals","WR",121,"KC",5,13,162,null],
    [353,"J.J. McCarthy","QB",37,"MIN",6,13,-89,null],
    [354,"Joe Mixon","RB",103,"FA",null,13,-79,null],
    [355,"Konata Mumpfield","WR",122,"LAR",11,13,33,null],
    [356,"Luke McCaffrey","WR",123,"WAS",7,13,-19,null],
    [357,"Sione Vaki","RB",104,"DET",6,14,97,283],
    [358,"Max Klare","TE",49,"LAR",11,13,52,null],
    [359,"Cedric Tillman","WR",124,"FA",null,14,null,null],
    [360,"Joshua Palmer","WR",125,"BUF",7,14,-8,null],
    [361,"Noah Gray","TE",50,"KC",5,14,15,null],
    [362,"Chris Brazzell II","WR",126,"CAR",5,14,319,null],
    [363,"Treylon Burks","WR",127,"WAS",7,14,300,null],
    [364,"Tyler Bass","K",22,"BUF",7,14,-123,null],
    [365,"Mac Jones","QB",38,"SF",8,14,6,null],
    [366,"Brenen Thompson","WR",128,"LAC",7,14,177,null],
    [367,"Jake Elliott","K",23,"PHI",10,14,-110,null],
    [368,"Ja'Tavion Sanders","TE",51,"CAR",5,14,-11,null],
    [369,"New York Jets","DST",25,"NYJ",13,15,62,285],
    [370,"Roman Wilson","WR",129,"PIT",9,14,172,null],
    [371,"Carolina Panthers","DST",26,"CAR",5,14,-104,null],
    [372,"Malik Benson","WR",130,"LV",13,14,163,null],
    [373,"New York Giants","DST",27,"NYG",8,14,-140,null],
    [374,"Ty Simpson","QB",39,"LAR",11,14,-96,null],
    [375,"Eli Heidenreich","RB",105,"PIT",9,14,-20,null],
    [376,"Justin Fields","QB",40,"KC",5,14,-32,null],
    [377,"Michael Carter","RB",106,"FA",null,14,191,null],
    [378,"Kalif Raymond","WR",131,"CHI",10,14,148,null],
    [379,"Savion Williams","WR",132,"GB",11,14,278,null],
    [380,"Zavion Thomas","WR",133,"CHI",10,14,-44,null],
    [381,"Raheim Sanders","RB",107,"CLE",11,14,253,null],
    [382,"Tennessee Titans","DST",28,"TEN",9,14,-109,null],
    [383,"Colbie Young","WR",134,"CIN",6,14,-30,null],
    [384,"Roschon Johnson","RB",108,"CHI",10,14,199,null],
    [385,"J'Mari Taylor","RB",109,"FA",null,14,null,null],
    [386,"Anthony Richardson Sr.","QB",41,"IND",13,14,44,null],
    [387,"Jawhar Jordan","RB",110,"FA",null,14,275,null],
    [388,"Justin Joly","TE",52,"FA",null,14,50,null],
    [389,"Noah Fant","TE",53,"NO",8,14,93,null],
    [390,"Demarcus Robinson","WR",135,"SF",8,14,103,null],
    [391,"Zane Gonzalez","K",24,"FA",null,14,121,null],
    [392,"John Metchie III","WR",136,"CAR",5,14,250,null],
    [393,"Dont'e Thornton Jr.","WR",137,"LV",13,14,203,null],
    [394,"Jameis Winston","QB",42,"NYG",8,14,-78,null],
    [395,"Tutu Atwell","WR",138,"LAR",11,14,217,null],
    [396,"Kene Nwangwu","RB",111,"NYJ",13,16,216,281],
    [397,"Tommy Tremble","TE",54,"CAR",5,14,-16,null],
    [398,"Joe Flacco","QB",43,"CIN",6,14,-59,null],
    [399,"Kyle Juszczyk","RB",112,"SF",8,14,1,null],
    [400,"Daniel Carlson","K",25,"NO",8,14,null,null],
    [401,"Jaylin Lane","WR",139,"WAS",7,14,213,null],
    [402,"Odell Beckham Jr.","WR",140,"NYG",8,14,-55,null],
    [403,"Barion Brown","WR",141,"NO",8,14,-34,null],
    [404,"CJ Daniels","WR",142,"LAR",11,14,-39,null],
    [405,"Devontez Walker","WR",143,"BAL",13,14,-82,null],
    [406,"Blake Grupe","K",26,"FA",null,14,-94,null],
    [407,"Luke Musgrave","TE",55,"GB",11,14,134,null],
    [408,"Ashton Dulin","WR",144,"IND",13,14,30,null],
    [409,"Chad Ryland","K",27,"ARI",14,14,-94,null],
    [410,"Marcus Mariota","QB",44,"WAS",7,14,104,null],
    [411,"Ryan Fitzgerald","K",28,"CAR",5,14,-76,null],
    [412,"Joey Slye","K",29,"TEN",9,14,-92,null],
    [413,"Washington Commanders","DST",29,"WAS",7,14,-131,null],
    [414,"Daniel Bellinger","TE",56,"TEN",9,14,205,null],
    [415,"Ben Sinnott","TE",57,"WAS",7,14,256,null],
    [416,"Jam Miller","RB",113,"FA",null,14,155,null],
    [417,"Jordan Whittington","WR",145,"LAR",11,14,-43,null],
    [418,"Cade Klubnik","QB",45,"NYJ",13,14,-49,null],
    [419,"Nick Westbrook-Ikhine","WR",146,"FA",null,14,247,null],
    [420,"Miami Dolphins","DST",30,"MIA",6,14,-128,null],
    [421,"Greg Dortch","WR",147,"BUF",7,15,163,null],
    [422,"Phil Mafah","RB",114,"FA",null,15,null,null],
    [423,"Elijah Higgins","TE",58,"ARI",14,15,-52,null],
    [424,"Las Vegas Raiders","DST",31,"LV",13,15,-153,null],
    [425,"Ben Sauls","K",30,"FA",null,15,-116,null],
    [426,"Isaiah Williams","WR",148,"NYJ",13,15,242,null],
    [427,"Brandon McManus","K",31,"FA",null,15,-36,null],
    [428,"Austin Hooper","TE",59,"ATL",11,15,232,null],
    [429,"Drew Stevens","K",32,"WAS",7,15,-115,null],
    [430,"Mitchell Evans","TE",60,"CAR",5,15,13,null],
    [431,"Tyler Goodson","RB",115,"ATL",11,15,null,null],
    [432,"John Bates","TE",61,"WAS",7,15,96,null],
    [433,"Dyami Brown","WR",149,"WAS",7,15,232,null],
    [434,"Khalil Herbert","RB",116,"FA",null,15,null,null],
    [435,"Tai Felton","WR",150,"MIN",6,15,115,null],
    [436,"Dylan Laube","RB",117,"LV",13,15,null,null],
    [437,"Jonnu Smith","TE",62,"GB",11,15,-39,null],
    [438,"Dohnte Meyers","WR",151,"CIN",6,15,11,null],
    [439,"Hunter Luepke","RB",118,"DAL",14,15,-16,null],
    [440,"Ronnie Rivers","RB",119,"LAR",11,15,136,null],
    [441,"Isaiah Williams","WR",152,"FA",null,15,null,null],
    [442,"Terrell Jennings","RB",120,"FA",null,15,205,null],
    [443,"Jeremy McNichols","RB",121,"WAS",7,15,null,null],
    [444,"Josh Williams","RB",122,"FA",null,15,-92,null],
    [445,"Deion Burks","WR",153,"IND",13,15,null,null],
    [446,"Corey Kiner","RB",123,"NE",11,15,null,null],
    [447,"Jahdae Walker","WR",154,"CHI",10,15,10,null],
    [448,"Austin Ekeler","RB",124,"FA",null,15,37,null],
    [449,"Zavier Scott","RB",125,"FA",null,15,null,null],
    [450,"Joe Milton III","QB",46,"DAL",14,15,-40,null],
    [451,"Tommy Myers","TE",63,"FA",null,15,null,null],
    [452,"Antonio Gibson","RB",126,"FA",null,15,174,null],
    [453,"Matt Hibner","TE",64,"BAL",13,15,null,null],
    [454,"Marlin Klein","TE",65,"HOU",8,15,76,null],
    [455,"Damien Martinez","RB",127,"FA",null,15,null,null],
    [456,"Zach Ertz","TE",66,"FA",null,15,159,null],
    [457,"Gardner Minshew II","QB",47,"ARI",14,15,-18,null],
    [458,"Elijah Moore","WR",155,"PHI",10,15,null,null],
    [459,"Dameon Pierce","RB",128,"PHI",10,15,null,null],
    [460,"Arizona Cardinals","DST",32,"ARI",14,15,-156,null],
    [461,"Jordan Watkins","WR",156,"SF",8,15,null,null],
    [462,"Theo Wease Jr.","WR",157,"FA",null,15,null,null],
    [463,"DeAndre Hopkins","WR",158,"BAL",13,15,149,null],
    [464,"Van Jefferson","WR",159,"FA",null,15,28,null],
    [465,"Riley Leonard","QB",48,"IND",13,15,146,null],
    [466,"Tyler Lockett","WR",160,"LV",13,15,null,null],
    [467,"Jabari Small","RB",129,"DET",6,15,null,null],
    [468,"Will Kacmarek","TE",67,"MIA",6,15,-21,null],
    [469,"Xavier Restrepo","WR",161,"TEN",9,15,null,null],
    [470,"Josh Oliver","TE",68,"MIN",6,15,-109,null],
    [471,"Jacob Cowing","WR",162,"SF",8,15,213,null],
    [472,"Ameer Abdullah","RB",130,"JAC",7,15,null,null],
    [473,"Jackson Hawes","TE",69,"BUF",7,15,-33,null],
    [474,"Lew Nichols III","RB",131,"FA",null,15,null,null],
    [475,"Tim Patrick","WR",163,"NYJ",13,15,96,null],
    [476,"Reggie Gilliam","RB",132,"NE",11,15,87,null],
    [477,"Tanner Koziol","TE",70,"JAC",7,15,90,null],
    [478,"Adam Trautman","TE",71,"DEN",10,15,-48,null],
    [479,"Xavier Smith","WR",164,"LAR",11,15,3,null],
    [480,"Patrick Ricard","RB",133,"NYG",8,15,84,null],
    [481,"Marquez Valdes-Scantling","WR",165,"FA",null,15,129,null],
    [482,"Jalen Reagor","WR",166,"FA",null,15,null,null],
    [483,"Chris Blair","WR",167,"ATL",11,15,null,null],
    [484,"Reggie Virgil","WR",168,"ARI",14,16,212,null],
    [485,"Michael Woods II","WR",169,"DEN",10,16,null,null],
    [486,"Sam Roush","TE",72,"CHI",10,16,72,null],
    [487,"Jimmy Horn Jr.","WR",170,"CAR",5,16,-43,null],
    [488,"British Brooks","RB",134,"HOU",8,16,73,null],
    [489,"Tyrod Taylor","QB",49,"GB",11,16,-149,null],
    [490,"Quinn Ewers","QB",50,"JAC",7,16,-139,null],
    [491,"Durham Smythe","TE",73,"BAL",13,16,-30,null],
    [492,"Jaydn Ott","RB",135,"FA",null,16,null,null],
    [493,"Cade Stover","TE",74,"HOU",8,16,31,null],
    [494,"Dominic Zvada","K",33,"NYG",8,16,-225,null],
    [495,"Jason Sanders","K",34,"NYJ",13,16,-192,null],
    [496,"Josh Cameron","WR",171,"JAC",7,16,-70,null],
    [497,"Frank Gore Jr.","RB",136,"BUF",7,16,154,null],
    [498,"Cash Jones","RB",137,"ATL",11,16,null,null],
    [499,"Tyson Bagent","QB",51,"CHI",10,16,15,null],
    [500,"Nate Boerkircher","TE",75,"JAC",7,16,105,null],
    [501,"Trey Lance","QB",52,"LAC",7,16,-39,null],
    [502,"Drew Sample","TE",76,"CIN",6,16,18,null],
    [503,"Luke Schoonmaker","TE",77,"DAL",14,16,-132,null],
    [504,"Jaret Patterson","RB",138,"FA",null,16,null,null],
    [505,"Tanner Hudson","TE",78,"FA",null,16,162,null],
    [506,"Velus Jones Jr.","WR",172,"FA",null,16,null,null],
    [507,"Lil'Jordan Humphrey","WR",173,"DEN",10,16,-170,null],
  ];

  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }

  // Turns each player's blended valueSignal into the board's "value"/"sexy
  // pick" flags -- this is the data-driven stand-in for what used to be my
  // own hand-typed guesses. Positive = FantasyPros' own ECR-vs-ADP delta
  // and/or ESPN's points projection rank him better than the field's ADP
  // does (he's likely to fall to you -- value); negative = the market is
  // drafting him ahead of what either signal thinks he's worth (name-value
  // outrunning the room -- the "sexy pick"/reach risk). The threshold
  // loosens with depth because a 6-spot swing at pick 8 is a real signal,
  // while the same swing at pick 400 is noise from a handful of samples --
  // past rank 200 the sample is too thin to trust either way, so no flag is
  // assigned.
  function deriveFlags(rank, valueSignal) {
    if (valueSignal === null || rank > 200) return [];
    const threshold = rank <= 50 ? 6 : rank <= 100 ? 10 : 15;
    if (valueSignal >= threshold) return ["value"];
    if (valueSignal <= -threshold) return ["trap"];
    return [];
  }

  function makeSeedPlayers() {
    return SEED_PLAYERS.map((r) => {
      const [rank, name, pos, posRank, team, bye, tier, valueSignal, espnRank] = r;
      return {
        id: slugify(name + "-" + team + "-" + pos),
        name,
        pos,
        posRank,
        team,
        bye,
        tier,
        rank,
        espnRank,
        valueSignal,
        flags: deriveFlags(rank, valueSignal),
      };
    });
  }

  // Bump this whenever SEED_PLAYERS is refreshed with a new rankings
  // snapshot. A returning visitor's board is saved in localStorage, so
  // without this, a code update alone would never reach anyone who already
  // has a saved draft -- they'd keep seeing whatever board existed the first
  // time they loaded the page, no matter how the seed data changes underneath
  // them. On load, a mismatched (or missing/pre-this-feature) version
  // refreshes just the player list -- settings and any picks already made
  // are left alone.
  const SEED_VERSION = "fantasypros-espn-blend-2026-09-01-v2";

  function defaultState() {
    return {
      settings: { teams: 12, mySlot: 5, scoring: "PPR", draftType: "SNAKE", roster: Object.assign({}, DEFAULT_ROSTER), auctionBudget: 200 },
      players: makeSeedPlayers(),
      seedVersion: SEED_VERSION,
      picks: [],
      ui: { posFilter: "ALL", search: "", hideDrafted: true, activeTab: "board" },
    };
  }

  const STORE_KEY = "edgerush_draft_v1";
  let state;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    state = raw ? JSON.parse(raw) : defaultState();
    if (!state || !state.settings || !state.players || !state.ui) state = defaultState();
    else if (state.seedVersion !== SEED_VERSION && state.seedVersion !== "custom") {
      // Built-in rankings changed since this board was last saved (or this
      // save predates the SEED_VERSION check entirely) -- refresh to the
      // current seed board, but keep settings/picks/ui as they were.
      state.players = makeSeedPlayers();
      state.seedVersion = SEED_VERSION;
    }
  } catch (e) {
    state = defaultState(); // storage unavailable (private mode, quota, etc.) -- run in-memory only
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      /* ignore -- in-memory state still works for the rest of the session */
    }
  }

  /* ---------------- derived state ---------------- */

  function totalRounds() {
    return ROSTER_ORDER.reduce((sum, k) => sum + (state.settings.roster[k] || 0), 0);
  }

  // Standard snake order: odd rounds go slot 1->T, even rounds go T->1.
  function slotOnClock(overall, teams) {
    const round = Math.ceil(overall / teams);
    const posInRound = overall - (round - 1) * teams;
    return round % 2 === 1 ? posInRound : teams - posInRound + 1;
  }

  function currentOverall() {
    return state.picks.length + 1;
  }
  function currentRound(teams) {
    return Math.ceil(currentOverall() / teams);
  }

  function picksUntilMe() {
    const teams = state.settings.teams;
    const mine = state.settings.mySlot;
    let overall = currentOverall();
    if (slotOnClock(overall, teams) === mine) return 0;
    for (let count = 0; count < teams * 2; count++) {
      if (slotOnClock(overall, teams) === mine) return count;
      overall++;
    }
    return null;
  }

  function myPickSequence() {
    const teams = state.settings.teams;
    const mine = state.settings.mySlot;
    const rounds = totalRounds();
    const out = [];
    for (let round = 1; round <= rounds; round++) {
      const overall = round % 2 === 1 ? (round - 1) * teams + mine : (round - 1) * teams + (teams - mine + 1);
      out.push({ round, overall });
    }
    return out;
  }

  function playerById(id) {
    return state.players.find((p) => p.id === id) || null;
  }
  function pickFor(id) {
    return state.picks.find((p) => p.playerId === id) || null;
  }
  function isDrafted(id) {
    return !!pickFor(id);
  }

  // Assigns my picks to roster slots in draft order: natural position slot
  // first, then FLEX (RB/WR/TE only), then bench, then an overflow bench
  // slot if every configured bench spot is already full. Recomputed fresh
  // every render rather than stored, so changing the roster template
  // mid-draft can't leave stale assignments behind.
  function computeMyRoster() {
    const slots = [];
    ROSTER_ORDER.forEach((type) => {
      const n = state.settings.roster[type] || 0;
      for (let i = 0; i < n; i++) slots.push({ type, playerId: null });
    });
    state.picks
      .filter((p) => p.owner === "me")
      .forEach((pk) => {
        const pl = playerById(pk.playerId);
        if (!pl) return;
        let idx = slots.findIndex((s) => s.type === pl.pos && s.playerId === null);
        if (idx === -1 && ["RB", "WR", "TE"].includes(pl.pos)) {
          idx = slots.findIndex((s) => s.type === "FLEX" && s.playerId === null);
        }
        if (idx === -1) idx = slots.findIndex((s) => s.type === "BENCH" && s.playerId === null);
        if (idx === -1) {
          slots.push({ type: "BENCH", playerId: null, overflow: true });
          idx = slots.length - 1;
        }
        slots[idx].playerId = pk.playerId;
      });
    return slots;
  }

  function positionRunLastN(n) {
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    state.picks.slice(-n).forEach((p) => {
      const pl = playerById(p.playerId);
      if (pl && counts.hasOwnProperty(pl.pos)) counts[pl.pos]++;
    });
    return counts;
  }

  function draftPhase(round, rounds) {
    if (round <= 3) return { label: "Foundation", text: "Best player available at RB/WR/TE. Resist the QB itch -- the position runs 15+ deep this year." };
    if (round <= 8) return { label: "Build", text: "Lock your starters. This is the window for a QB1 and your RB2/WR3 depth." };
    if (round <= Math.max(9, rounds - 4)) return { label: "Depth & bench", text: "Handcuffs with real standalone value, a TE2 if needed, high-upside bench flyers." };
    return { label: "Lottery tickets", text: "Rookie stashes, injury-comeback bets, and your DST/K -- last, always." };
  }

  // Bye-week stacking check, per position: QB/TE/DST/K only ever start ONE
  // player, so any two of them sharing a bye leaves that week uncovered --
  // the whole point of a backup at those spots is to NOT be dark the same
  // week as your starter. RB/WR start more than one, so the real mistake
  // there isn't any partial overlap (two of three WRs sharing a bye is
  // normal and usually fine) -- it's the WHOLE starting group going dark at
  // once. Both cases reduce to the same rule: flag a bye week once the
  // number of your rostered players at that position sharing it reaches
  // max(startersNeeded, 2). FLEX isn't modeled separately (it can be filled
  // by RB/WR/TE, so it doesn't have one fixed position to check against).
  function byeCollisionThreshold(pos) {
    return Math.max(state.settings.roster[pos] || 0, 2);
  }

  // { pos: { bye: count } } across everything currently on my roster.
  function myByeCounts() {
    const out = {};
    state.picks.filter((pk) => pk.owner === "me").forEach((pk) => {
      const pl = playerById(pk.playerId);
      if (!pl || !pl.bye) return;
      out[pl.pos] = out[pl.pos] || {};
      out[pl.pos][pl.bye] = (out[pl.pos][pl.bye] || 0) + 1;
    });
    return out;
  }

  // Plain-language summary of any bye-week collisions that already exist on
  // my roster (used in the nudges panel, after the picks are made).
  function byeCollisionSummary() {
    const myPlayers = state.picks.filter((pk) => pk.owner === "me").map((pk) => playerById(pk.playerId)).filter(Boolean);
    const out = [];
    ["QB", "RB", "WR", "TE", "DST", "K"].forEach((pos) => {
      const atPos = myPlayers.filter((pl) => pl.pos === pos && pl.bye);
      if (atPos.length < 2) return;
      const threshold = byeCollisionThreshold(pos);
      const byBye = {};
      atPos.forEach((pl) => { (byBye[pl.bye] = byBye[pl.bye] || []).push(pl); });
      Object.keys(byBye).forEach((bye) => {
        const group = byBye[bye];
        if (group.length >= threshold) {
          const names = group.map((pl) => pl.name).join(", ");
          out.push(`${group.length} of your ${pos}${group.length > 1 ? "s" : ""} share bye week ${bye} (${names}) -- make sure something else on your roster covers that week.`);
        }
      });
    });
    return out;
  }

  function generateNudges() {
    const out = [];
    const myPicks = state.picks.filter((p) => p.owner === "me");
    const myPlayers = myPicks.map((p) => playerById(p.playerId)).filter(Boolean);
    const posCount = { QB: 0, RB: 0, WR: 0, TE: 0 };
    myPlayers.forEach((pl) => { if (posCount.hasOwnProperty(pl.pos)) posCount[pl.pos]++; });
    const teams = state.settings.teams;
    const round = currentRound(teams);
    const rounds = totalRounds();

    const last = myPlayers[myPlayers.length - 1];
    if (last && last.flags.includes("trap")) {
      out.push({ level: "danger", text: `"${last.name}" carries a boom/bust flag -- real name value, real bust risk. Watch early-season usage closely and don't be precious about benching or trading it.` });
    }
    if (posCount.QB === 0 && round <= 5) {
      out.push({ level: "good", text: "No QB yet -- that's fine. This position is 15+ deep; keep taking RB/WR value." });
    }
    if (posCount.QB === 0 && round >= 6 && round <= 10) {
      out.push({ level: "info", text: "Good window to grab your QB1 -- the Herbert/Lawrence/Goff/Purdy tier tends to fall right about here." });
    }
    if (posCount.QB >= 1) {
      const qbPick = myPicks.find((p) => { const pl = playerById(p.playerId); return pl && pl.pos === "QB"; });
      if (qbPick && Math.ceil(qbPick.overall / teams) <= 5) {
        out.push({ level: "warn", text: "You spent an early pick at QB -- make sure it's outproducing the RB/WR you passed on. Deep position this year, hold it to a high bar." });
      }
    }
    if (posCount.RB === 0 && round >= 4) {
      out.push({ level: "warn", text: "Zero RB territory now -- own it. Commit your next couple of picks to RB or the plan falls apart at the flex." });
    }
    const run = positionRunLastN(5);
    Object.keys(run).forEach((pos) => {
      if (run[pos] >= 3) out.push({ level: "danger", text: `${pos} run in progress -- ${run[pos]} of the last 5 picks. Decide now: get in on it or fade it and pivot.` });
    });
    if (round >= rounds - 2) {
      const openStarter = computeMyRoster().find((s) => s.playerId === null && s.type !== "BENCH");
      if (openStarter) out.push({ level: "danger", text: `Still an open starting ${openStarter.type} with the draft almost over -- don't punt it for a 4th bench flier.` });
    }
    byeCollisionSummary().forEach((msg) => out.push({ level: "warn", text: msg }));

    if (out.length === 0) out.push({ level: "info", text: "No alerts right now -- keep taking the best player on your board relative to tier, not name recognition." });
    return out.slice(0, 5);
  }

  /* ---------------- rendering ---------------- */

  function statCard(label, value, variant) {
    return `<div class="card stat-card${variant ? " " + variant : ""}"><div class="value mono">${value}</div><div class="label">${label}</div></div>`;
  }

  function renderScoreboard() {
    const teams = state.settings.teams;
    const overall = currentOverall();
    const round = currentRound(teams);
    const onClock = slotOnClock(overall, teams);
    const until = picksUntilMe();
    document.getElementById("scoreboard").innerHTML =
      statCard("Round", `${Math.min(round, totalRounds())} / ${totalRounds()}`) +
      statCard("Overall pick", overall) +
      statCard("On the clock", `Slot ${onClock}`, "warn") +
      statCard("Picks till you", until === 0 ? "YOU'RE UP" : until, until === 0 ? "danger" : "");
  }

  function renderSettingsForm() {
    document.getElementById("cfg-teams").value = state.settings.teams;
    document.getElementById("cfg-slot").value = state.settings.mySlot;
    document.getElementById("cfg-scoring").value = state.settings.scoring;
    document.getElementById("cfg-budget").value = state.settings.auctionBudget;
    document.getElementById("cfg-budget-control").style.display = state.settings.draftType === "AUCTION" ? "flex" : "none";
    document.querySelectorAll("#draft-type-toggle button").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === state.settings.draftType);
    });
    document.getElementById("roster-inputs").innerHTML = ROSTER_ORDER.map(
      (k) => `<div class="rf"><label>${k}</label><input type="number" min="0" max="10" data-rk="${k}" value="${state.settings.roster[k]}"></div>`
    ).join("");
  }

  function renderRosterList() {
    const slots = computeMyRoster();
    const round = currentRound(state.settings.teams);
    const rounds = totalRounds();
    document.getElementById("roster-list").innerHTML = slots.map((s) => {
      const pl = s.playerId ? playerById(s.playerId) : null;
      const urgent = !pl && round >= rounds - 3;
      return `<li style="display:flex; justify-content:space-between; gap:var(--space-2); font-size:0.85rem; ${urgent ? "color:var(--color-danger);" : ""}">
        <span class="mono text-faint">${s.type}</span>
        <span style="flex:1; text-align:right;">${pl ? Util.escapeHtml(pl.name) : "open"}</span>
      </li>`;
    }).join("");
  }

  function renderRunTracker() {
    const run = positionRunLastN(8);
    document.getElementById("run-tracker").innerHTML = ["QB", "RB", "WR", "TE"].map((pos) => {
      const c = run[pos];
      const pct = Math.round((c / 8) * 100);
      return `<div class="run-row">
        <span class="run-row__pos">${pos}</span>
        <span class="run-row__track"><span class="run-row__fill${c >= 3 ? " alert" : ""}" style="width:${pct}%"></span></span>
        <span class="run-row__count">${c}</span>
      </div>`;
    }).join("");
    const alertPos = ["QB", "RB", "WR", "TE"].find((p) => run[p] >= 3);
    document.getElementById("run-alert").innerHTML = alertPos
      ? `<p class="text-danger" style="margin:var(--space-2) 0 0; font-size:0.82rem;">${alertPos} run -- ${run[alertPos]} of the last 8 picks</p>`
      : "";
  }

  function renderPosFilter() {
    document.getElementById("pos-filter").innerHTML = POSES.map(
      (p) => `<button type="button" data-pos="${p}" class="${state.ui.posFilter === p ? "active" : ""}">${p}</button>`
    ).join("");
  }

  function tierBadgeClass(t) {
    return t === 1 ? "tier1" : t === 2 ? "tier2" : "neutral";
  }

  function renderBoard() {
    const q = state.ui.search.trim().toLowerCase();
    const rows = state.players
      .filter((p) => {
        if (state.ui.posFilter !== "ALL" && p.pos !== state.ui.posFilter) return false;
        if (q && !p.name.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q)) return false;
        if (state.ui.hideDrafted && isDrafted(p.id)) return false;
        return true;
      })
      // Real consensus rank already reflects tier order -- sort on it
      // directly instead of tier+name so within-tier order matches the
      // actual board, falling back to name for any imported rows with no
      // rank (e.g. a hand-typed CSV).
      .sort((a, b) => (a.rank || 9999) - (b.rank || 9999) || a.name.localeCompare(b.name));

    const body = document.getElementById("board-body");
    if (rows.length === 0) {
      body.innerHTML = `<tr><td colspan="6"><div class="empty-state">No players match -- clear filters or import a fresh board.</div></td></tr>`;
      return;
    }

    const byeCounts = myByeCounts();

    body.innerHTML = rows.map((p) => {
      const drafted = isDrafted(p.id);
      const pk = drafted ? pickFor(p.id) : null;
      const flagsHtml = p.flags.map((f) => {
        const meta = FLAG_META[f] || ["neutral", f];
        return `<span class="badge ${meta[0]}">${meta[1]}</span>`;
      }).join(" ");
      const posLabel = p.posRank ? `${p.pos}${p.posRank}` : p.pos;

      // Would drafting THIS player complete a bye-week collision with what
      // I already have at this position? (See byeCollisionThreshold.)
      let byeHtml = p.bye || "&ndash;";
      if (!drafted && p.bye) {
        const already = (byeCounts[p.pos] && byeCounts[p.pos][p.bye]) || 0;
        if (already >= byeCollisionThreshold(p.pos) - 1) {
          byeHtml = `${p.bye} <span class="badge warn" title="Would put ${already + 1} of your ${p.pos}s on bye week ${p.bye}">clash</span>`;
        }
      }

      let actionHtml;
      if (drafted) {
        actionHtml = `<span class="text-faint">${pk.owner === "me" ? "YOUR PICK" : "gone"}${pk.paid ? ` &middot; $${pk.paid}` : ""}</span>`;
      } else if (state.settings.draftType === "AUCTION") {
        actionHtml = `<span class="auction-bid">$<input type="number" min="1" max="${state.settings.auctionBudget}" value="1" data-bidfor="${p.id}">
          <button type="button" class="btn" data-act="mine-auction" data-id="${p.id}">Mine</button>
          <button type="button" class="btn" data-act="gone" data-id="${p.id}">Gone</button></span>`;
      } else {
        actionHtml = `<button type="button" class="btn" data-act="mine" data-id="${p.id}">Mine</button>
          <button type="button" class="btn" data-act="gone" data-id="${p.id}">Gone</button>`;
      }

      return `<tr${drafted ? ' style="opacity:0.4;"' : ""}>
        <td><span class="badge ${tierBadgeClass(p.tier)}">T${p.tier}</span></td>
        <td>${drafted ? `<s>${Util.escapeHtml(p.name)}</s>` : Util.escapeHtml(p.name)} <span class="text-faint">${posLabel}</span></td>
        <td>${Util.escapeHtml(p.team)}</td>
        <td>${byeHtml}</td>
        <td>${flagsHtml}</td>
        <td style="text-align:right;">${actionHtml}</td>
      </tr>`;
    }).join("");
  }

  function findNextMine(seq, overall) {
    const next = seq.find((s) => s.overall >= overall);
    return next ? next.overall : null;
  }

  function renderMyDraft() {
    const teams = state.settings.teams;
    const round = currentRound(teams);
    const rounds = totalRounds();
    const phase = draftPhase(round, rounds);
    document.getElementById("phase-banner").innerHTML = `<strong>R${Math.min(round, rounds)} — ${phase.label}.</strong> ${phase.text}`;

    document.getElementById("nudges").innerHTML = generateNudges().map(
      (n) => `<div class="banner ${n.level} tight">${n.text}</div>`
    ).join("");

    const seq = myPickSequence();
    const overall = currentOverall();
    const nextMine = findNextMine(seq, overall);
    document.getElementById("pick-list").innerHTML = seq.map((s) => {
      const cls = s.overall < overall ? "done" : s.overall === nextMine ? "next" : "";
      return `<span class="chip ${cls}">R${s.round} &middot; #${s.overall}</span>`;
    }).join("");

    document.getElementById("roster-board").innerHTML = computeMyRoster().map((s) => {
      const pl = s.playerId ? playerById(s.playerId) : null;
      const cls = pl ? "filled" : round >= rounds - 3 ? "urgent" : "";
      return `<div class="roster-slot ${cls}"><div class="roster-slot__type">${s.type}</div><div class="roster-slot__name">${pl ? Util.escapeHtml(pl.name) : "Open"}</div></div>`;
    }).join("");
  }

  function renderAuctionTab() {
    const spent = state.picks.filter((p) => p.owner === "me" && p.paid).reduce((a, p) => a + p.paid, 0);
    const budget = state.settings.auctionBudget;
    const remaining = budget - spent;
    const mySlots = computeMyRoster();
    const filled = mySlots.filter((s) => s.playerId).length;
    const slotsLeft = Math.max(1, mySlots.length - filled);
    const maxBid = Math.max(1, remaining - (slotsLeft - 1));
    document.getElementById("auction-stats").innerHTML =
      statCard("Budget", "$" + budget) +
      statCard("Spent", "$" + spent) +
      statCard("Remaining", "$" + remaining, "warn") +
      statCard("Max sensible bid", "$" + maxBid);
  }

  const STRATEGY_HTML = `
    <article>
      <h2>Round by round</h2>
      <p>Think of a draft in four phases, not twelve or sixteen individual picks. <strong>Foundation (rounds 1&ndash;3):</strong>
        take the best RB/WR/TE on your board &mdash; pure talent and volume, no position requirement.
        <strong>Build (rounds 4&ndash;8):</strong> lock starters, including your QB1 if you waited.
        <strong>Depth &amp; bench (rounds 9 to about four-from-the-end):</strong> handcuffs with real standalone
        value, a TE2 if your TE1 is boom/bust, high-upside bench pieces. <strong>Lottery tickets (final rounds):</strong>
        rookie stashes, comeback bets, and only then your DST/K.</p>
      <div class="pullquote">The single biggest mistake in fantasy drafts isn't one bad pick &mdash; it's panicking
        into position runs that were never yours to chase.</div>

      <h2>Don't draft a QB in round 1 (or usually before round 6)</h2>
      <p>In a 1-QB league, the position is absurdly deep. A dozen-plus quarterbacks finish as viable weekly starters,
        and several of them (Goff, Purdy, Lawrence, Herbert-type profiles) are available five or six rounds after
        the "elite" tier goes off the board. Spending a top-24 pick on a QB means passing on a bell-cow RB or true
        WR1 for positional value you could have had at half the cost. The math only flips in
        <strong>superflex/2-QB</strong> leagues, where QBs become legitimately scarce and early investment is correct.</p>

      <h2>Hero RB, Zero RB, or balanced?</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Build</th><th>Idea</th><th>Best case</th><th>Worst case</th></tr></thead>
          <tbody>
            <tr><td>Hero RB</td><td>One elite bell-cow early, then pivot hard to WR/TE for several rounds</td>
              <td>True RB1 production without punting the receiver corps</td>
              <td>Your one RB gets hurt and you're replacing a foundation piece, not a luxury</td></tr>
            <tr><td>Zero RB</td><td>Ignore RB early, stack elite WRs, mine RB value from rounds 8&ndash;13</td>
              <td>WRs are more likely to hold their draft-day value than RBs &mdash; you bank stability</td>
              <td>If your late-round RB bets whiff, you're starting waiver-wire backs at your flex all year</td></tr>
            <tr><td>Balanced / BPA</td><td>Fill RB and WR need as value dictates, no fixed plan</td>
              <td>Simple, adapts to how the room actually drafts</td>
              <td>No plan means no edge &mdash; you can drift into thin at both spots</td></tr>
          </tbody>
        </table>
      </div>
      <p>None of these is "correct" in the abstract &mdash; they're responses to how RBs get hurt and lose touches
        more than WRs do. Pick a lane based on what falls to you in rounds 1&ndash;2, don't force it.</p>

      <h2>Avoiding the sexy pick</h2>
      <p>ADP is a popularity contest as much as a talent ranking. A player's draft position often reflects
        <em>last year's</em> highlight reel more than this year's actual opportunity &mdash; rookies with a hot
        preseason, a name you recognize from a big game, a "buy low" narrative that's really just hope. The fix
        isn't to avoid these players entirely; it's to price them at their tier, not their name.</p>
      <div class="card">
        <p style="margin:0;"><strong>Watch for the flag:</strong> players tagged <span class="badge negative">&#9888; sexy pick</span>
          on the board carry real name-value but a track record of hype outrunning production &mdash; boom/bust
          rookies off one big preseason, or aging stars whose role has quietly shrunk. Draft them where their tier
          says to, not where the buzz says to.</p>
      </div>

      <h2>Roster construction rules that hold up</h2>
      <p>Don't handcuff your own RB1 in the double-digit rounds &mdash; a backup with no standalone value is a
        wasted pick nine times out of ten; spend that pick on a player who helps you even if nothing changes
        upstairs. Reinforce WR depth all draft: when a starting WR gets hurt, the vacated targets usually scatter
        across two or three teammates rather than consolidating into one obvious must-add, so bench WR depth
        matters more than bench RB depth. And build a roster that survives losing your best player for a month,
        not a roster that only wins if everything breaks right.</p>

      <h2>In-draft discipline</h2>
      <p>Value relative to ADP beats need on paper &mdash; but need wins ties. If two players grade out equally on
        your board and one fills an empty starting spot, take that one. And when three of the same position leave
        the board in five picks, don't assume you have to follow: check whether the run is actually about to reach
        your tier, or whether it's early panic from teams two picks ahead of the value cliff.</p>
    </article>
    <aside class="card">
      <h3>Quick reference</h3>
      <ul>
        <li>QB before round 6 in 1-QB leagues: almost never worth it.</li>
        <li>One elite RB early beats zero elite RBs &mdash; but two isn't automatically better than one plus a stacked WR corps.</li>
        <li>Handcuffs: skip unless the backup has standalone value.</li>
        <li>DST/K: last two picks, always. Stream DST off matchups all season.</li>
        <li>A "sexy pick" flag means check the tier before you reach, not skip the player.</li>
      </ul>
    </aside>
  `;

  const AUCTION_ARTICLE_HTML = `
    <article style="max-width:66ch;">
      <h2>Auction strategy, short version</h2>
      <p><strong>Stars &amp; scrubs</strong> vs <strong>balanced</strong> is the real fork in the road.
        Stars-and-scrubs spends 60%+ of your budget on two or three elite players and fills the rest with $1
        flyers; balanced spreads $15&ndash;30 across six or seven solid starters. Balanced is more forgiving of one
        bad pick; stars-and-scrubs has a higher ceiling but one bust tanks your team.</p>
      <p><strong>Nominate players you don't want.</strong> Throwing out a name you have no interest in, early,
        drains other teams' budgets on someone who isn't going to help you. Save your actual targets for the
        middle third of the auction, once budgets are already dented.</p>
      <p><strong>Price enforcement.</strong> If a player is going for less than they're worth, bid it up even if
        you don't plan to buy &mdash; it forces the eventual buyer to spend more of their budget, which helps you
        later. Stop before the price you'd actually pay.</p>
      <p><strong>The $1 reserve rule.</strong> Never let your remaining budget dip below $1 per remaining roster
        slot. The Max sensible bid tile above already backs that reserve out for you.</p>
    </article>
  `;

  function render() {
    renderScoreboard();
    renderSettingsForm();
    renderRosterList();
    renderRunTracker();
    renderPosFilter();
    renderBoard();
    renderMyDraft();
    renderAuctionTab();
    document.getElementById("strategy-layout").innerHTML = STRATEGY_HTML;
    document.getElementById("auction-article").innerHTML = AUCTION_ARTICLE_HTML;
    save();
  }

  /* ---------------- actions ---------------- */

  function draftPlayer(id, owner, paid) {
    if (isDrafted(id)) return;
    state.picks.push({ overall: currentOverall(), playerId: id, owner, paid: paid || null });
    render();
  }

  function undoLast() {
    if (state.picks.length === 0) return;
    state.picks.pop();
    render();
  }

  document.getElementById("board-body").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === "mine") draftPlayer(id, "me");
    else if (act === "gone") draftPlayer(id, "other");
    else if (act === "mine-auction") {
      const input = document.querySelector(`input[data-bidfor="${id}"]`);
      const amt = Math.max(1, parseInt(input && input.value, 10) || 1);
      draftPlayer(id, "me", amt);
    }
  });

  document.getElementById("pos-filter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-pos]");
    if (!b) return;
    state.ui.posFilter = b.dataset.pos;
    renderPosFilter();
    renderBoard();
    save();
  });

  document.getElementById("search-box").addEventListener("input", (e) => {
    state.ui.search = e.target.value;
    renderBoard();
    save();
  });

  document.getElementById("hide-drafted").addEventListener("change", (e) => {
    state.ui.hideDrafted = e.target.checked;
    renderBoard();
    save();
  });

  document.getElementById("draft-type-toggle").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-type]");
    if (!b) return;
    state.settings.draftType = b.dataset.type;
    renderSettingsForm();
    renderBoard();
    save();
  });

  document.getElementById("btn-apply").addEventListener("click", () => {
    const teams = parseInt(document.getElementById("cfg-teams").value, 10) || 12;
    let slot = parseInt(document.getElementById("cfg-slot").value, 10) || 1;
    if (slot > teams) slot = teams;
    state.settings.teams = teams;
    state.settings.mySlot = slot;
    state.settings.scoring = document.getElementById("cfg-scoring").value;
    state.settings.auctionBudget = parseInt(document.getElementById("cfg-budget").value, 10) || 200;
    document.querySelectorAll("#roster-inputs input").forEach((inp) => {
      state.settings.roster[inp.dataset.rk] = parseInt(inp.value, 10) || 0;
    });
    render();
  });

  document.getElementById("btn-reset-draft").addEventListener("click", () => {
    state.picks = [];
    render();
  });

  let fullResetArmed = false;
  const fullResetBtn = document.getElementById("btn-full-reset");
  fullResetBtn.addEventListener("click", () => {
    if (!fullResetArmed) {
      fullResetArmed = true;
      fullResetBtn.textContent = "Click again to confirm";
      setTimeout(() => { fullResetArmed = false; fullResetBtn.textContent = "Factory reset"; }, 4000);
      return;
    }
    state = defaultState();
    fullResetArmed = false;
    fullResetBtn.textContent = "Factory reset";
    render();
  });

  function parseCsv(text) {
    return text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(",").map((s) => s.trim()))
      .filter((parts) => parts.length >= 3 && parts[0] && parts[0].toLowerCase() !== "name")
      .map((parts) => ({
        id: slugify(parts[0] + "-" + (parts[2] || "") + "-" + (parts[1] || "")),
        name: parts[0],
        pos: (parts[1] || "").toUpperCase(),
        team: parts[2] || "",
        tier: parseInt(parts[3], 10) || 9,
        flags: parts[4] ? parts[4].split("|").map((s) => s.trim()).filter(Boolean) : [],
        bye: parts[5] ? parseInt(parts[5], 10) || null : null,
        rank: null,
        posRank: null,
        espnRank: null,
        valueSignal: null,
      }));
  }

  document.getElementById("btn-import").addEventListener("click", () => {
    const text = document.getElementById("import-box").value;
    const players = parseCsv(text);
    if (players.length === 0) return;
    state.players = players;
    // Mark this board as hand-imported so a future built-in SEED_VERSION
    // bump doesn't silently overwrite it -- see the seedVersion check above.
    state.seedVersion = "custom";
    render();
  });

  function currentBoardCsv() {
    const rows = ["name,pos,team,tier,flags,bye,status,owner,paid"];
    state.players.forEach((p) => {
      const pk = pickFor(p.id);
      rows.push([p.name, p.pos, p.team, p.tier, p.flags.join("|"), p.bye || "", pk ? "drafted" : "available", pk ? pk.owner : "", pk && pk.paid ? pk.paid : ""].join(","));
    });
    return rows.join("\n");
  }

  document.getElementById("btn-export-download").addEventListener("click", () => {
    const blob = new Blob([currentBoardCsv()], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "draft-board.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById("btn-export-show").addEventListener("click", () => {
    const box = document.getElementById("import-box");
    box.value = currentBoardCsv();
    box.focus();
    box.select();
  });

  document.getElementById("tab-toggle").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    document.querySelectorAll("#tab-toggle button").forEach((x) => x.classList.toggle("active", x === b));
    ["board", "mydraft", "strategy", "auction"].forEach((t) => {
      document.getElementById("tab-" + t).style.display = t === b.dataset.tab ? "" : "none";
    });
    state.ui.activeTab = b.dataset.tab;
    const p = new URLSearchParams(location.search);
    p.set("tab", b.dataset.tab);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
    save();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "z" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      undoLast();
    }
  });

  /* ---------------- init ---------------- */
  const initialTab = new URLSearchParams(location.search).get("tab") || state.ui.activeTab || "board";
  const initialBtn = document.querySelector(`#tab-toggle button[data-tab="${initialTab}"]`);
  if (initialBtn) initialBtn.click();

  render();
})();
